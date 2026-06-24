# pi-toolcall-guard: DeepSeek V4 Tool-Call Defense Spec

> **For:** Spec review — not yet implementation-ready. Each section defines a feature increment with acceptance criteria.
>
> **Goal:** Add four defensive layers to pi-toolcall-guard that intercept, repair, validate, and explain the 16+ documented DeepSeek V4 tool-calling failure modes before they break a session.
>
> **Architecture:** All four features live inside the existing extension — no new packages. Argument repair and schema pre-check are new `tool_call` handler stages (between preflight and rules engine). Enhanced enrichment extends `src/enrich.ts`. Built-in rules are new `.md` files in `builtin-rules/`.
>
> **Tech Stack:** TypeScript (existing extension runtime), no new dependencies.

---

## Feature A: Argument Repair

### Goal

Deterministically fix the four common DeepSeek V4 argument malformations **before** the tool executes. No token cost, no round-trip. Log each repair as a metric event so the operator can measure how often each pattern fires.

### File Structure

| File | Responsibility |
|---|---|
| `src/repair/index.ts` | Orchestrator: given `toolName` + `input`, run all repairs, return normalized input + list of repairs applied |
| `src/repair/patterns.ts` | The four pattern matchers + fixers, each exported as a `RepairPattern` |
| `index.ts` | New `tool_call` handler stage (existing file, add call to repair after preflight, before rules engine) |

### Repair Patterns

All patterns are consensus-ordered (first-match wins, most specific first).

#### Pattern 1: Boolean-as-String Coercion

```
Condition:  Tool schema declares field type="boolean"
            AND input[field] === "true" | "false" | "True" | "False"
Fix:        Coerce to boolean value true/false
```

Access schema via `pi.getAllTools()` → find matching tool → its parameter types.

#### Pattern 2: Null Strip for Optional Fields

```
Condition:  input[field] === null
            AND field is NOT in the tool's required parameters list
Fix:        delete input[field]
```

#### Pattern 3: JSON-String Array Parse

```
Condition:  Tool schema declares field type="array" (of strings/primitives)
            AND typeof input[field] === "string"
            AND input[field] starts with "[" and ends with "]"
Fix:        input[field] = JSON.parse(input[field])
            On parse failure → skip (leave for schema pre-check to catch)
```

#### Pattern 4: Empty-Object Strip

```
Condition:  typeof input[field] === "object"
            AND input[field] !== null
            AND !Array.isArray(input[field])
            AND Object.keys(input[field]).length === 0
            AND field is NOT in required parameters
Fix:        delete input[field]
```

#### Pattern 5: Unknown-Parameter Strip (Anti-hallucination)

```
Condition:  input has key that is NOT in the tool's schema parameter list
Fix:        delete input[key]
            (A repair note is emitted so the model learns)
```

### Interface

```typescript
// src/repair/index.ts

export interface Repair {
  pattern: string;       // e.g. "bool-string", "null-strip", "json-array", "empty-object", "unknown-param"
  field: string;         // the argument key that was repaired
  detail?: string;       // human-readable note, e.g. "coerced 'true'→true"
}

export interface RepairResult {
  input: Record<string, unknown>;   // normalized input
  repairs: Repair[];                // empty if nothing was repaired
}

export function repairInput(
  toolName: string,
  input: Record<string, unknown>,
  tools: ToolDefinition[],   // from pi.getAllTools()
): RepairResult;
```

### Metrics

Each repair is recorded as a `GuardEvent` with kind `"repair"`:

```typescript
{ kind: "repair"; toolName: string; pattern: string; field: string }
```

A follow-up metric `"repair_recovered"` fires if the tool executes successfully after repair (same heuristic as the existing `preflight_recovered`).

### Edge Cases / Exclusions

- If `input` is empty or undefined → skip all repairs (nothing to fix)
- If tool name is not in `pi.getAllTools()` → skip (no schema to check against)
- If field value is already correct type → skip (no-op)
- `null` on a **required** field → do NOT strip (will be caught by schema pre-check as an error — the model must supply a value)
- Arrays inside nested objects → only top-level arguments are repaired in v1; nested is future work

### Acceptance

| # | Scenario | Expect |
|---|---|---|
| A1 | Model sends `timeout: null` on optional shell arg | `input.timeout` is deleted silently, tool runs, metric logged |
| A2 | Model sends `files: "[\"a.ts\"]"` where schema expects array | `input.files` becomes `["a.ts"]`, tool runs |
| A3 | Model sends `verbose: {}` on optional bool | `input.verbose` is deleted, tool runs |
| A4 | Model sends `enabled: "true"` where schema expects boolean | `input.enabled` becomes `true`, tool runs |
| A5 | Model sends hallucinated key `extraParam: "x"` not in schema | `input.extraParam` is deleted, tool runs |
| A6 | Model sends valid args (`command: "ls", timeout: 5000`) | No repairs, pass-through, no metric |
| A7 | Model sends `null` for a **required** param (`command: null`) | NOT stripped — passed through to schema pre-check (Feature B) |

---

## Feature B: Schema Pre-Check

### Goal

Validate tool call arguments against the registered tool schema **after** repair but **before** execution. Catch invalid JSON, missing required fields, type mismatches, and leftover malformations that repair couldn't fix. Block with an actionable `[guard]` message instead of letting the tool error out.

### File Structure

| File | Responsibility |
|---|---|
| `src/schema/index.ts` | Orchestrator: extract schema from `pi.getAllTools()`, run checks, return pass/block |
| `src/schema/checks.ts` | Individual check functions (JSON valid, required fields, types, unknown keys) |
| `index.ts` | Insert schema check call after repair, before rules engine |

### Checks (in order)

#### Check 1: JSON Argument Validity

```
Condition:  tool.function.arguments comes as a JSON string (most frameworks)
            Try JSON.parse. If fails → block with repair note
```

Note: In pi, arguments are already parsed objects at `tool_call` event time — this check is a guard for any framework where arguments might arrive as a raw string. If already an object, skip.

#### Check 2: Required Fields Present

```
For each field in schema.required (or inferred from pi tool def):
  if input[field] is undefined or null → block
  reason: "Missing required parameter \"{field}\" for {toolName}."
```

#### Check 3: No Unknown Fields (Anti-Hallucination Gate)

```
For each key in input:
  if key NOT in schema.properties → block
  reason: "Unknown parameter \"{key}\" for {toolName}. Remove it and resend."
```

Note: this overlaps with repair pattern 5 (unknown-param strip). If repair strips unknown params in a "repair" mode, schema pre-check should run AFTER repair and should NOT block on stripped params. The two features work together — repair fixes what it can, schema pre-check blocks what it can't.

#### Check 4: Type Mismatch

```
For each field in input:
  if schema declares type === "string" AND typeof input[field] !== "string" → block
  if schema declares type === "number" AND typeof input[field] !== "number" → block
  if schema declares type === "boolean" AND typeof input[field] !== "boolean" → block
  if schema declares type === "array" AND !Array.isArray(input[field]) → block
```

Type-check only for primitive types. Skip `object` and complex nested types in v1.

### Interface

```typescript
// src/schema/index.ts

export interface SchemaViolation {
  check: string;        // "missing-required" | "unknown-field" | "type-mismatch"
  field?: string;
  expected?: string;
  actual?: string;
}

export interface SchemaCheckResult {
  ok: boolean;
  violations: SchemaViolation[];
  blockReason?: string;  // rendered only when !ok
}

export function checkSchema(
  toolName: string,
  input: Record<string, unknown>,
  tools: ToolDefinition[],
): SchemaCheckResult;
```

### Block Message Format

When schema check fails, the `tool_call` handler returns:

```typescript
{
  block: true,
  reason: `[guard] ${toolName} argument check failed:
  - Missing required: command
  - Unknown params: extraFlag
Fix the arguments and resend.`,
}
```

### Metrics

```typescript
{ kind: "schema_block"; toolName: string; violations: string }
```

### Edge Cases / Exclusions

- If tool has no schema registered (not in `pi.getAllTools()`) → skip all checks (pass)
- If `input` is empty and tool has no required params → pass
- If `input` is empty and tool HAS required params → block ("missing required params")
- Type enforcement is best-effort for v1: only primitive types are checked. Object/array contents are not recursively validated.

### Acceptance

| # | Scenario | Expect |
|---|---|---|
| B1 | Model omits required `command` field on shell tool | Blocked with `Missing required: command` |
| B2 | Model sends `command: 123` (number not string) | Blocked with `Type mismatch: command expected string got number` |
| B3 | Model sends valid args after repair | Pass-through |
| B4 | Tool has no registered schema | Skipped, pass-through |

---

## Feature C: Enhanced Error Enrichment

### Goal

When a tool does error (despite repair + pre-check), enrich the error result with a concise, actionable `[guard]` hint specific to DeepSeek V4 failure patterns. Each hint is one sentence — tell the model what went wrong and what to do next.

### File Structure

| File | Responsibility |
|---|---|
| `src/enrich.ts` | Existing file. Add new DeepSeek-specific rules to the `RULES` array. |
| `index.ts` | No changes (enrichment already fires on `tool_result`). |

### New Enrich Rules

Inserted into the existing ordered `RULES` array. Order matters (most specific first).

```typescript
{
  id: "deepseek-null-optional",
  test: /parameter '(\w+)' must not be null|null is not allowed for/i,
  hint: "[guard] DeepSeek sent null for an optional parameter. Omit the field entirely.",
},
{
  id: "deepseek-string-array",
  test: /expected array.*got string|must be an array/i,
  hint: "[guard] DeepSeek encoded an array as a JSON string. Send a native array or ask the model to retry.",
},
{
  id: "deepseek-empty-object",
  test: /expected (?:string|number|boolean).*got object|must not be an object/i,
  hint: "[guard] DeepSeek sent an empty object {} as a placeholder. Send the expected value or omit the field.",
},
{
  id: "deepseek-bool-string",
  test: /expected boolean.*got string|must be a boolean/i,
  hint: "[guard] DeepSeek sent a boolean as a quoted string ('true'/'false'). Send the unquoted boolean value.",
},
{
  id: "deepseek-hallucinated-param",
  test: /unknown (?:parameter|property|argument) (\w+)/i,
  hint: "[guard] DeepSeek hallucinated a parameter not in the tool schema. Remove the unknown key and resend.",
},
{
  id: "deepseek-invalid-json",
  test: /JSON\.parse|unexpected token|Unexpected token|invalid json/i,
  hint: "[guard] DeepSeek generated invalid JSON in tool arguments. Check argument syntax and retry.",
},
```

Each hint is **one line**, uses `[guard]` prefix (matching existing convention), states what happened + what to do.

### Existing Rules That Still Apply

The existing `stale-anchor`, `enoent`, `command-not-found`, `permission` rules remain unchanged. They catch errors unrelated to DeepSeek's specific patterns. The new rules are added **after** `stale-anchor` (highest priority) and **before** the generic `schema` rule, so DeepSeek-specific hints fire before the generic fallback.

### Acceptance

| # | Scenario | Expect |
|---|---|---|
| C1 | Tool errors with `parameter 'timeout' must not be null` | Appends `[guard] DeepSeek sent null for an optional parameter...` |
| C2 | Tool errors with `expected array, got string` | Appends `[guard] DeepSeek encoded an array as a JSON string...` |
| C3 | Tool errors with `unknown parameter 'extraFlag'` | Appends `[guard] DeepSeek hallucinated a parameter...` |
| C4 | Tool errors with `ENOENT` (unrelated) | Existing `[guard] The path doesn't exist...` (unchanged) |
| C5 | Tool succeeds | No enrichment (unchanged) |

---

## Feature D: Built-In MD Rules for DeepSeek-Specific Guardrails

### Goal

Provide user-inspectable, editable markdown rule files that document DeepSeek V4 quirks as guardrail rules. These fire a `[guard]` reminder when the model tries certain patterns — not a hard block, but a contextual nudge that educates in-band.

### File Structure

| File | Responsibility |
|---|---|
| `builtin-rules/deepseek-reasoning-content.md` | New rule — warns about reasoning_content preservation |
| `builtin-rules/deepseek-tool-choice.md` | New rule — warns about tool_choice limitations |
| `builtin-rules/deepseek-thinking-default.md` | New rule — warns about default thinking mode |

### Rule: `deepseek-reasoning-content.md`

```markdown
---
description: Preserve reasoning_content in multi-turn tool calls with DeepSeek V4
condition:
  - "reasoning_content"
  - "400.*reasoning_content"
  - "must be passed back"
scope: "tool:bash"
interruptMode: never
---
DeepSeek V4 requires reasoning_content from assistant messages with tool_calls
to be preserved in subsequent requests. Without it, the API returns HTTP 400.
Store `msg.reasoning_content` alongside each assistant turn that has tool_calls.
You MAY strip it when a new user turn arrives.
```

### Rule: `deepseek-tool-choice.md`

```markdown
---
description: tool_choice="required" is not supported in DeepSeek V4 thinking mode
condition:
  - "tool_choice.*required"
  - "tool_choice.*function.*name"
  - "force.*tool"
scope: "tool:bash"
interruptMode: never
---
DeepSeek V4 in thinking mode rejects `tool_choice="required"` and
`{"type":"function","function":{"name":"..."}}` with HTTP 400.
Only `"auto"` and `"none"` work. Disable thinking first, or route the request
through the `/anthropic` endpoint.
```

### Rule: `deepseek-thinking-default.md`

```markdown
---
description: DeepSeek V4 defaults to thinking mode — disable it for simple tool calls
condition:
  - "deepseek-v4-pro"
  - "deepseek-v4-flash"
  - "deepseek-chat"
  - "deepseek-reasoner"
scope: "tool:bash"
interruptMode: never
---
DeepSeek V4 enables thinking mode by default. This burns 30-300 extra tokens
per call and silences temperature/top_p/penalty parameters. For simple tool
calls, pass `extra_body={"thinking": {"type": "disabled"}}`. Only enable
thinking when the task genuinely needs reasoning.
```

### Rule Loading

The existing `loadRules()` function already reads all `.md` files from `builtin-rules/`. No loader changes needed — just drop the new files.

### Interrupt Mode

All three rules use `interruptMode: never` — they produce a **reminder** (attached to the tool result), not a block. The rules engine already handles this via `shouldInterrupt()` returning false for `interruptMode: "never"`, which routes to `renderToolReminder` instead of `renderInterrupt`.

### Acceptance

| # | Scenario | Expect |
|---|---|---|
| D1 | Model writes `tool_choice="required"` in bash | Reminder fires on next tool result (not a block) |
| D2 | Model mentions `reasoning_content` or `400` error | Reminder fires |
| D3 | Model sends a request with `deepseek-v4-pro` in the endpoint config | Reminder fires |
| D4 | Unrelated tool call | No reminder (rules scoped to `tool:bash` by default; if scope is omitted, they fire on any tool) |

---

## Integration: Event Flow (All Features)

```
pi.on("tool_call")
  │
  ├─ 1. preflight (path normalization) — existing
  ├─ 2. nudge (bash → native tool) — existing
  ├─ 3. repairInput() — NEW (Feature A)
  │     └─ repairs applied → metrics logged
  ├─ 4. checkSchema() — NEW (Feature B)
  │     └─ violations → block with reason
  ├─ 5. rules engine — existing
  │     └─ block/remind
  └─ 6. return { block?, reason? }

pi.on("tool_result")
  │
  ├─ 1. enrichError() — existing + NEW (Feature C rules added)
  └─ 2. return { content: enriched } — existing

Built-in rules (Feature D) loaded at session start via existing loadRules()
  └─ fire as reminders on matching tool calls — no code changes needed
```

## Metric Event Types (all features)

```typescript
// Existing
{ kind: "preflight" | "nudge" | "enrich" | "rule" | "preflight_recovered" }

// New — Feature A
{ kind: "repair"; toolName: string; pattern: string; field: string }

// New — Feature A follow-up
{ kind: "repair_recovered"; toolName: string }

// New — Feature B
{ kind: "schema_block"; toolName: string; violations: string }
```

No changes to the existing `metrics.ts` or `GuardEvent` union type — the new kinds are added to the union and logged via the existing `appendFileSync` path.

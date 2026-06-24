# Context Management & Usage Telemetry — Design Spec

**Status:** Approved for planning (2026-06-13)
**Scope:** Two sibling PI extensions — `pi-usage-recorder` (Phase 0) and `pi-context-manager` (Phase 1, MVP).
**Goal:** Reduce token spend across a coding session **without hurting agent performance**, and — first — make the spend *measurable* so optimization is driven by real numbers, not guesses.

---

## 1. Background & motivation

This is feature work for the custom PI harness (siblings: `pi-capability-index`, `pi-research-library`, `pi-hermes-memory`). PI already ships **native compaction** (summarize when the context window nears full), so context never *overflows*. The remaining problem is purely **cost** (tokens billed) and secondarily **clutter** (stale content misleading the model).

### 1.1 Where the tokens actually go (analysis)

In a coding-agent transcript, cost is dominated by **tool results** — chiefly **file reads** and **bash/grep/search dumps**. They are the worst on every axis:

- **Large** — a `read` of a 400-line file is ~5–6k tokens; a test/build dump can be more.
- **Monotonic** — they only accumulate; every turn re-sends the whole pile.
- **Stale fastest** — after an `edit`/`write`, the earlier `read` of that file is *wrong*, yet persists.
- **Redundant** — re-reading a file leaves N copies, only the last of which matters.

A close, *often-overlooked* second: **historical `thinking` blocks**. Verified in PI source — `convertToLlm` returns assistant messages untouched (`case "assistant": return m`), so **PI re-sends every past turn's extended-thinking verbatim** as input on every turn. With extended thinking that is easily 1–3k tokens/turn accumulating into tens of thousands of *uncached-value* tokens.

### 1.2 The prompt-cache constraint (why the obvious design is wrong)

Anthropic prompt caching reads the stable prefix at ~0.1× input price and writes new content at ~1.25×. Two consequences drive the entire design:

1. **Editing old history re-busts the cache.** Collapsing a message at position *k* invalidates the cache from *k* to the end, which is re-billed at write price **on the turn the collapse is introduced**. Rough break-even for collapsing a 5k item with a 30k suffix is **~75 more turns** — longer than most sessions. *Under a warm cache, aggressively collapsing old content is net-negative.*
2. **The cache TTL is 5 minutes.** Human-paced or interrupted sessions frequently have a *cold* cache, so the prefix is re-written at full price anyway — meaning collapsing old content then saves full freight with **no re-bust penalty**.

So value is **usage-pattern-dependent**: marginal under fast autonomous loops (warm cache), real under human-paced use (cold cache). This is exactly why **measurement comes first**.

### 1.3 Ideas explicitly rejected (and why)

- **Reordering context by importance ("important near the tail").** Breaks tool-call↔tool-result pairing *and* is maximally cache-hostile (re-busts every turn). Replaced by *tiered retention in place*.
- **Deleting tool results.** A `toolResult` carries a `toolCallId` linking to a `toolCall` block; orphaning either is rejected by the provider. So pruning = **collapse content to a placeholder**, never delete.
- **⟦scratch⟧ inline tagging + system-prompt convention.** Relies on model compliance, adds prompt cost, narrow win. Deferred.
- **Retrospective "mark this old block" tools + ref-id menu.** A ref-id→content menu would itself sit in context every turn (self-defeating); and retrospective collapse is the cache-expensive case. Deferred; the rules cover the common cases for free.

### 1.4 What survives into the MVP

Two rules whose value holds in *both* cache regimes, need *no* model cooperation, and carry low risk:

- **Strip aged `thinking` blocks** (the fat, uncached-value, resent content).
- **Collapse provably-superseded reads** (the clearest "this is wrong now" case).

Everything else is deferred until telemetry proves it is worth the complexity.

---

## 2. Architecture overview

Two independent extensions, each its own package under `~/.pi/agent/extensions/`, loaded by PI's jiti (no build step), default-export `(pi: ExtensionAPI) => void`. Both follow harness invariants: **fail-open**, **per-request (never mutate the durable session)**, **TDD**.

```
pi-usage-recorder   (Phase 0)  — observe-only telemetry → ~/.pi/usage/usage.jsonl
pi-context-manager  (Phase 1)  — per-request transcript shaping via the `context` hook
```

They are decoupled: the context-manager does not import the recorder. The recorder is how you *evaluate* the context-manager (off vs on), but it stands alone and ships first.

### 2.1 Key PI APIs (verified in installed source)

- `turn_end` event → `{ turnIndex, message, toolResults }`. When `message.role === "assistant"`, `message.usage` is present.
- `Usage = { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`.
- `pi.getContextUsage()` → `{ tokens: number|null, contextWindow, percent: number|null }`.
- `context` event → `{ messages: AgentMessage[] }`; returning `{ messages }` (`ContextEventResult`) replaces the messages for the request. **Fired before a provider request is sent.**
- `tool_result` event → carries `{ toolName, input, content, isError }` (the tool's args are on `input`; `tool_execution_end` does NOT carry args — known gotcha from `pi-capability-index`).
- Message model: `Message = UserMessage | AssistantMessage | ToolResultMessage`; assistant content blocks are `text | thinking | toolCall`; `ToolResultMessage` has `toolCallId`, `toolName`, `content: (TextContent|ImageContent)[]`, `isError`, `timestamp`.

### 2.2 Resolved findings (verified in source 2026-06-13)

- **The `context` result is per-request ephemeral; the durable session is untouched.** Confirmed in `pi-agent-core` `agent-loop.js` `streamAssistantResponse`: `transformContext`'s output is a *local* variable fed only to `convertToLlm` for the request, while `context.messages` (the durable transcript) is appended to separately and never reassigned from the transform. The extension runner also hands the handler a `structuredClone` of the messages and catches handler errors itself (defence-in-depth fail-open).
- **The transform can be a pure function of the message array — no event tracking needed.** Each assistant `toolCall` block carries `{ id, name, arguments }` (the file path is in `arguments`), and each `ToolResultMessage` links back via `toolCallId`. So mutation history and read paths are *derivable from the transcript itself*. This supersedes the event-tracking store described in §4.2: the context-manager keeps **no** cross-event state, which makes monotonicity automatic (a deterministic function over an append-only transcript) and removes any reliance on event ordering.

---

## 3. Phase 0 — `pi-usage-recorder`

### 3.1 Responsibility

Record one row of token + context usage per assistant turn, append-only, keyed by session, for offline/at-a-glance trend analysis. Observe-only: it registers **no** `context`/`before_agent_start` rewrite and changes nothing the model sees.

### 3.2 Data model

One append-only JSONL file: `~/.pi/usage/usage.jsonl`. One row per assistant turn:

```jsonc
{
  "sessionId": "2026-06-13T14-22-05-3f9c",  // assigned at session_start
  "turnIndex": 7,
  "ts": "2026-06-13T14:31:02.114Z",
  "model": "claude-opus-4-8",
  "input": 1840,
  "output": 612,
  "cacheRead": 48213,
  "cacheWrite": 1920,
  "totalTokens": 52585,
  "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0 },
  "ctxTokens": 50133,        // pi.getContextUsage().tokens   (may be null)
  "ctxWindow": 200000,
  "ctxPercent": 25.07        // may be null
}
```

JSONL chosen over SQLite: append-only, no schema migration, trivially greppable/loadable for trend analysis; can be ingested into anything later. Rows are self-describing via `sessionId`.

### 3.3 Runtime wiring

- `session_start` → generate `sessionId` (ISO timestamp + 4 random hex), store in extension state. Ensure `~/.pi/usage/` exists.
- `turn_end` → if `message.role === "assistant"`: read `message.usage` + `pi.getContextUsage()`, compose the row, append a line to `usage.jsonl`. Non-assistant turns are skipped.
- All handlers wrapped fail-open: on any error, swallow and continue (never disrupt the agent). A dropped row is acceptable.

### 3.4 `/usage` command

Reads `usage.jsonl`, filters to the current `sessionId` (and supports `/usage all` for cross-session), prints:

- **Totals:** input / output / cacheRead / cacheWrite / total tokens; total `cost.total`.
- **Cache-hit ratio:** `cacheRead / (input + cacheRead + cacheWrite)` — the single best signal of whether the prefix is being re-billed (low ratio ⇒ cold cache ⇒ collapsing old content pays).
- **Context-fill trend:** per-turn `ctxPercent` sparkline / min-max, so growth is visible at a glance.

Rendered as a compact text summary (no TUI overlay needed for v1).

### 3.5 Config

- `USAGE_RECORDER_DISABLE` — if set, the extension registers nothing (kill switch).
- `USAGE_RECORDER_FILE` — override path (default `~/.pi/usage/usage.jsonl`).

### 3.6 Testing

Pure helpers extracted and unit-tested (vitest):
- `usageRowFromEvent(sessionId, turnIndex, message, ctxUsage)` → row object (handles non-assistant → null, null ctx fields).
- `summarize(rows)` → totals, cache-hit ratio, context-fill min/max/last.
- A wiring test: default export registers `session_start` + `turn_end` + the `usage` command; a synthetic assistant `turn_end` appends exactly one well-formed row to a temp file.

---

## 4. Phase 1 — `pi-context-manager` (MVP)

### 4.1 Responsibility

Per-request, shape the `messages` array sent to the provider to drop **uncached-value** content, without breaking provider constraints and without mutating the durable session. Two rules only.

### 4.2 Deriving state from the transcript (no event tracking)

Per the §2.2 finding, the transform is a **pure function of `event.messages`** and keeps no cross-event state. Each pass derives, from the array alone:

- `calls: Map<toolCallId, { name, arguments }>` — built from every assistant `toolCall` block. Gives each `ToolResultMessage` its tool name and the originating args (incl. file path).
- `lastMutation: Map<canonicalPath, messageIndex>` — the latest array index of an `edit`/`write` result per path (canonicalized: forward-slashed, lowercased on Windows).
- **Turn = assistant-message count.** The hot window is the last *N* assistant messages and everything after them (see §4.3); no `turn_start`/`turn_end` bookkeeping needed.

No durable storage; recomputed each session. (If profiling later shows event ordering is unreliable, fall back to deriving turn from message position inside the `context` handler.)

### 4.3 Rule 1 — strip aged thinking

In the `context` handler, for each assistant message **older than the hot window** (not among the last `HOT_WINDOW` turns, default **3**), remove `thinking` blocks from its `content` array. Keep `text` and `toolCall` blocks untouched. The hot window guarantees the most-recent tool-loop turn's thinking survives (Anthropic's only hard requirement). If removing thinking would empty an assistant message's content, leave a single empty `text` block to keep the message valid.

### 4.4 Rule 2 — collapse superseded reads

For each **cold** `toolResult` whose tool is `read` (v1: `read` only) and whose path satisfies `lastMutation[path] > thisIndex` (a later edit/write exists), replace its `content` with a single `TextContent`:

```
[read <basename> — ~<T> tokens elided; superseded by a later edit/write. Re-read if needed.]
```

`toolCallId`, `toolName`, `isError` are preserved → tool-call↔result pairing remains valid. The path is recovered from the originating `toolCall.arguments` via the `calls` map (§4.2). Reads inside the hot window are never collapsed (anti-thrash).

### 4.5 Cache-safety invariants

1. **Never edit the hot window** — the last `HOT_WINDOW` turns stay byte-identical to native, preserving the live cache tail.
2. **Monotonic collapse** — once a message is collapsed it stays collapsed every later turn; never re-expand or reshuffle. Keeps the cache breakpoint stable and as far back as possible.
3. **No reordering** — chronological order is preserved absolutely.

### 4.6 Pairing-safety invariant

The transform must never produce an orphaned `toolCall` (assistant block whose `toolResult` is missing) or orphaned `toolResult`. Since we only *replace content* and never remove messages, this holds by construction; a unit test asserts it over generated transcripts anyway.

### 4.7 Failure boundary

The `context` handler wraps the whole pipeline; on **any** error it returns the original `messages` unchanged. A bug can cost tokens but can never corrupt a request or break the agent.

### 4.8 Observability

Optional minimal `context_status` tool (pull-only): reports, for the last transform, `{ thinkingBlocksStripped, readsCollapsed, estTokensElided, hotWindow }`. Primary evaluation is via Phase 0 telemetry (run off vs on, compare `usage.jsonl`).

### 4.9 Config

- `CONTEXT_MANAGER_DISABLE` — kill switch (registers nothing).
- `CONTEXT_HOT_WINDOW` — turns kept fully intact (default 3).
- `CONTEXT_RULE_THINKING` / `CONTEXT_RULE_READS` — toggle each rule independently (default on).

### 4.10 Testing

Pure pipeline over synthetic `AgentMessage[]`:
- aged thinking stripped, hot-window thinking preserved;
- superseded read collapsed to placeholder; non-superseded / hot-window read untouched;
- pairing always valid (no orphaned toolCall/toolResult) — property-style over generated transcripts;
- monotonic stability — collapsing across simulated turns never re-expands;
- empty-content guard (assistant message with only thinking → valid after strip);
- fail-open — a handler that throws internally returns the original array.
- One through-the-`context`-hook wiring test.

---

## 5. Phasing & exit criteria

- **Phase 0 (recorder):** ship; collect ≥ a few real sessions of `usage.jsonl`. *Exit:* `/usage` shows a credible cache-hit ratio and context-fill trend.
- **Phase 1 (context-manager MVP):** ship behind the two rule toggles; verify the `context`-ephemerality question first. *Exit:* with the manager **on vs off** on comparable sessions, `usage.jsonl` shows reduced per-turn `input + cacheWrite` (or reduced `ctxTokens` growth) with no observed regression in task completion.
- **Deferred (gate on Phase 0/1 numbers):** budget/eviction ranking, ⟦scratch⟧ tagging, retrospective marking. Build only if telemetry shows prefix-read/context-growth cost is materially hurting spend.

## 6. Risks

- **`context`-result persistence** (§2.2) — load-bearing; verify first.
- **Cache re-bust on first collapse** — Rule 2 collapses old reads; under a warm cache this can be net-negative for short sessions. Mitigated by: monotonic + hot-window invariants, and by Phase 0 making the actual cost visible (cacheWrite spikes). If telemetry shows it hurts in warm-cache use, gate Rule 2 behind a cold-cache / long-session heuristic.
- **Thinking-signature / provider rules** — stripping aged thinking is standard and safe (only the latest tool-loop turn's thinking is required, preserved by the hot window). Validate against the active provider in the Phase 1 verification turn.
- **Multi-extension cache interaction** — `pi-capability-index` rewrites the *system prompt* (`before_agent_start`); this rewrites *messages* (`context`). Different surfaces; both move the cache breakpoint. When the system prompt changes, our collapses are effectively free that turn.

## 7. Out of scope

- Reimplementing or tuning PI native compaction (we only *delay* it by shrinking per-turn size).
- System-prompt slimming (owned by `pi-capability-index`).
- Cross-session learning / persistent importance models.

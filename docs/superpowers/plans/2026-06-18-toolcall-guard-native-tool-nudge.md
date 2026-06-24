# Native-Tool Nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third subsystem to `pi-toolcall-guard` that intercepts `bash` calls doing a job a dedicated tool does better (`cat`→read, `grep`→grep, `find`→find, `sed -i`→edit) and blocks them with a one-line redirect, so weaker models stay on the structured tools (hashline anchors, context-collapse, edit safety) instead of routing around them.

**Architecture:** A pure `src/nudge.ts` classifies a bash command string and returns a redirect or `null`. `index.ts` calls it in the existing `tool_call` handler's `try` block on `bash` events, blocking with `{ block: true, reason }` and recording a `nudge` metric. Detection is deliberately conservative: any pipe/redirect/chaining/substitution, or any flag/predicate a native tool can't honor, passes through untouched.

**Tech Stack:** TypeScript (ESM), vitest. No new dependencies.

## Global Constraints

- **Never throw into `tool_call`** — the nudge branch lives inside the handler's existing `try { … } catch { return; }`. A throw would block the tool.
- **Conservative by default:** when in doubt, pass (`return null`). A false block frustrates the model more than a missed nudge helps. Bypass on any of `| & ; < > \`` or `$(` (pipes, redirects, chaining, substitution).
- **Compact reasons:** one line each, prefixed `[guard] `, matching the guard's existing voice.
- **No recovery tracking for nudges:** do NOT add `bash` to `pendingBlock` — the model recovers by calling a *different* tool, which the per-tool `pendingBlock` set cannot match, and the next unrelated `bash` success would log a false recovery. The `nudge` metric is the signal.
- **Degrade-to-noop is preserved:** the nudge runs only after the metrics dir is created (same as preflight); no new IO at registration.
- Line endings: LF. Commits are path-scoped (repo has unrelated dirty files) and end with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- `src/nudge.ts` (new) — pure `nudge(command): NudgeResult | null` and the `NudgeResult` type. Sole owner of bash-classification logic.
- `src/metrics.ts` (modify) — extend the `GuardEvent` union with the `nudge` variant.
- `index.ts` (modify) — call `nudge` in the `tool_call` handler's `bash` branch.
- `scripts/report.mjs` (modify) — aggregate and display a `nudge` column.
- `test/nudge.test.ts` (new) — unit tests for `nudge`.
- `test/integration.test.ts` (modify) — end-to-end nudge cases through the registered handler.
- `test/report.test.mjs` (modify) — nudge aggregation/formatting.

---

### Task 1: Pure `nudge` classifier

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/nudge.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/nudge.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface NudgeResult { rule: string; tool: string; reason: string }`
  - `function nudge(command: string): NudgeResult | null`
  - Rule ids and target tools: `"cat-read"→read`, `"grep"→grep`, `"find"→find`, `"sed-edit"→edit`.

- [ ] **Step 1: Write the failing test**

Create `test/nudge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nudge } from "../src/nudge";

describe("nudge — cat → read", () => {
	it("nudges a bare single-file cat", () => {
		const n = nudge("cat src/utils.ts");
		expect(n?.rule).toBe("cat-read");
		expect(n?.tool).toBe("read");
		expect(n?.reason).toContain("read tool");
	});
	it("nudges cat with a numbering flag", () => {
		expect(nudge("cat -n src/a.ts")?.rule).toBe("cat-read");
	});
	it("passes cat with no file (stdin)", () => {
		expect(nudge("cat")).toBeNull();
	});
	it("passes a multi-file cat (concatenation)", () => {
		expect(nudge("cat a.ts b.ts")).toBeNull();
	});
});

describe("nudge — grep → grep", () => {
	it("nudges a bare grep with a path", () => {
		expect(nudge("grep foo src/a.ts")?.rule).toBe("grep");
	});
	it("nudges grep with recursive/line-number flags", () => {
		expect(nudge("grep -rn foo src")?.tool).toBe("grep");
	});
	it("passes grep with a context flag it cannot map", () => {
		expect(nudge("grep -A3 foo a.ts")).toBeNull();
	});
});

describe("nudge — find → find", () => {
	it("nudges a simple name search", () => {
		expect(nudge('find . -name "*.ts"')?.rule).toBe("find");
	});
	it("nudges a bare directory listing", () => {
		expect(nudge("find src")?.tool).toBe("find");
	});
	it("passes find with -type", () => {
		expect(nudge("find . -type f")).toBeNull();
	});
	it("passes find with -exec", () => {
		expect(nudge("find . -name x.ts -exec rm {}")).toBeNull();
	});
});

describe("nudge — sed -i → edit", () => {
	it("nudges an in-place sed", () => {
		const n = nudge("sed -i s/a/b/ file.ts");
		expect(n?.rule).toBe("sed-edit");
		expect(n?.tool).toBe("edit");
	});
	it("nudges in-place sed with a backup suffix", () => {
		expect(nudge("sed -i.bak s/a/b/ file.ts")?.rule).toBe("sed-edit");
	});
	it("passes a non-in-place sed (read-only stream)", () => {
		expect(nudge("sed s/a/b/ file.ts")).toBeNull();
	});
});

describe("nudge — never fires on composed or unrelated commands", () => {
	it("passes piped commands", () => {
		expect(nudge("cat a.ts | head")).toBeNull();
	});
	it("passes redirections", () => {
		expect(nudge("cat a.ts > out.txt")).toBeNull();
	});
	it("passes command substitution", () => {
		expect(nudge("grep foo $(ls)")).toBeNull();
	});
	it("passes chaining", () => {
		expect(nudge("cat a.ts && echo done")).toBeNull();
	});
	it("passes unrelated commands", () => {
		expect(nudge("npm test")).toBeNull();
	});
	it("passes empty input", () => {
		expect(nudge("   ")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run test/nudge.test.ts`
Expected: FAIL — cannot resolve `../src/nudge`.

- [ ] **Step 3: Write minimal implementation**

Create `src/nudge.ts`:

```ts
export interface NudgeResult {
	rule: string;
	tool: string;
	reason: string;
}

// Pipes, redirections, command substitution, chaining → the model wants shell
// composition the native tools can't express. Never nudge these.
const COMPOUND_RE = /[|&;<>`]|\$\(/;

// find predicates/actions the native find tool may not honor → don't nudge.
const FIND_UNSAFE_RE =
	/(^|\s)-(?:exec|execdir|delete|type|newer|size|mtime|mmin|regex|iregex|prune|print0|maxdepth|mindepth)(\s|$)/;

function tokenize(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Classify a bash command. Returns a redirect to a native tool, or null to let
 * the command run as-is. Conservative: only the bare, single-purpose forms of
 * cat/grep/find/sed -i are redirected; anything composed or carrying a flag a
 * native tool can't honor passes through.
 */
export function nudge(command: string): NudgeResult | null {
	const cmd = command.trim();
	if (!cmd) return null;
	if (COMPOUND_RE.test(cmd)) return null;

	const tokens = tokenize(cmd);
	const bin = tokens[0];
	const rest = tokens.slice(1);
	const flags = rest.filter((t) => t.startsWith("-"));
	const operands = rest.filter((t) => !t.startsWith("-"));

	if (bin === "cat") {
		const flagsOk = flags.every((f) => f === "-n" || f === "-b");
		if (operands.length === 1 && flagsOk) {
			return {
				rule: "cat-read",
				tool: "read",
				reason:
					"Use the read tool, not cat — read returns LINE#HASH anchors required for edits.",
			};
		}
		return null;
	}

	if (bin === "grep") {
		const flagsOk = flags.every((f) => /^-[rRnilw]+$/.test(f));
		if (operands.length >= 1 && flagsOk) {
			return {
				rule: "grep",
				tool: "grep",
				reason:
					"Use the grep tool, not bash grep — its output is structured and collapsible.",
			};
		}
		return null;
	}

	if (bin === "find") {
		if (FIND_UNSAFE_RE.test(cmd)) return null;
		return {
			rule: "find",
			tool: "find",
			reason:
				"Use the find tool, not bash find — its output is structured and collapsible.",
		};
	}

	if (bin === "sed") {
		const inPlace = rest.some(
			(t) => /^-{1,2}i/.test(t) || t.startsWith("--in-place"),
		);
		if (inPlace) {
			return {
				rule: "sed-edit",
				tool: "edit",
				reason:
					"Use the edit tool, not sed -i — edit validates anchors and previews changes; sed -i bypasses both.",
			};
		}
		return null;
	}

	return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run test/nudge.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/nudge.ts agent/extensions/pi-toolcall-guard/test/nudge.test.ts
git commit -m "feat(guard): native-tool nudge classifier"
```

---

### Task 2: Wire the nudge into the tool_call handler

**Files:**
- Modify: `agent/extensions/pi-toolcall-guard/src/metrics.ts` (extend `GuardEvent`)
- Modify: `agent/extensions/pi-toolcall-guard/index.ts` (import + `bash` branch in `tool_call`)
- Test: `agent/extensions/pi-toolcall-guard/test/integration.test.ts` (add cases)

**Interfaces:**
- Consumes: `nudge`, `NudgeResult` (Task 1).
- Produces: a new metric `{ kind: "nudge"; toolName: string; rule: string; tool: string }`; behavioral block on nudged `bash` calls.

- [ ] **Step 1: Write the failing test**

Add these `it(...)` blocks inside the existing `describe("guard integration", …)` in `test/integration.test.ts` (after the last test, before the closing `});`):

```ts
	it("nudges a bash cat to the read tool and records it", () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "n1", input: { command: "cat src/utils.ts" } },
			{ cwd: dir },
		);
		expect(res.block).toBe(true);
		expect(res.reason).toContain("read tool");
		const log = readFileSync(join(dir, "metrics", ".pi-guard-metrics.jsonl"), "utf8");
		expect(log).toContain('"nudge"');
	});

	it("passes a composed bash command untouched", () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "n2", input: { command: "cat a.ts | head" } },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
	});

	it("passes an unrelated bash command untouched", () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "n3", input: { command: "npm test" } },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run test/integration.test.ts`
Expected: FAIL — the `cat` case returns `undefined` (no nudge wired yet).

- [ ] **Step 3: Write minimal implementation**

In `src/metrics.ts`, extend the union:

```ts
export type GuardEvent =
	| { kind: "preflight"; outcome: "normalized" | "block"; toolName: string }
	| { kind: "preflight_recovered"; toolName: string }
	| { kind: "enrich"; matched: boolean; rule?: string; toolName: string }
	| { kind: "nudge"; toolName: string; rule: string; tool: string };
```

In `index.ts`, add the import alongside the existing `./` imports:

```ts
import { nudge } from "./nudge";
```

In the `pi.on("tool_call", (event, ctx) => { try { … } })` handler, immediately after `const input = (event.input ?? {}) as Record<string, unknown>;` and before the `const out = preflight(…)` line, insert:

```ts
				// Native-tool nudge: redirect bash invocations a dedicated tool does
				// better (cat→read anchors, grep/find→structured+collapsible output,
				// sed -i→edit safety). Conservative; see src/nudge.ts.
				if (event.toolName === "bash") {
					const command =
						typeof input.command === "string" ? input.command : "";
					const n = nudge(command);
					if (n) {
						metrics.record({
							kind: "nudge",
							toolName: "bash",
							rule: n.rule,
							tool: n.tool,
						});
						return { block: true, reason: `[guard] ${n.reason}` };
					}
					return;
				}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run test/integration.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run && npm run typecheck`
Expected: all tests pass; `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/metrics.ts agent/extensions/pi-toolcall-guard/index.ts agent/extensions/pi-toolcall-guard/test/integration.test.ts
git commit -m "feat(guard): wire native-tool nudge into tool_call"
```

---

### Task 3: Surface nudges in the report

**Files:**
- Modify: `agent/extensions/pi-toolcall-guard/scripts/report.mjs`
- Test: `agent/extensions/pi-toolcall-guard/test/report.test.mjs`

**Interfaces:**
- Consumes: the `nudge` metric (Task 2); existing `aggregate`/`formatReport` exports.
- Produces: a `nudges` field on each row + totals, and a `nudge` column in the formatted report.

- [ ] **Step 1: Write the failing test**

Add this `it(...)` to `test/report.test.mjs` (it already imports `aggregate` and `formatReport` from `../scripts/report.mjs`; reuse those imports):

```js
	it("counts nudge events per tool and shows a nudge column", () => {
		const { rows, totals } = aggregate([
			{ kind: "nudge", toolName: "bash", rule: "cat-read", tool: "read" },
			{ kind: "nudge", toolName: "bash", rule: "grep", tool: "grep" },
		]);
		const bash = rows.find((r) => r.tool === "bash");
		expect(bash.nudges).toBe(2);
		expect(totals.nudges).toBe(2);
		expect(formatReport({ rows, totals })).toContain("nudge");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run test/report.test.mjs`
Expected: FAIL — `bash.nudges` is `undefined`, report has no `nudge` column.

- [ ] **Step 3: Write minimal implementation**

In `scripts/report.mjs`:

(a) In `aggregate`'s `get(tool)` initializer, add `nudges: 0`:

```js
			r = { tool, blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0, nudges: 0 };
```

(b) In the event loop, add a branch after the `enrich` branch:

```js
			else if (e.kind === "nudge") r.nudges++;
```

(c) In the `rows.sort` comparator, include nudges in the activity weight:

```js
		rows.sort(
			(a, b) =>
				b.blocks + b.enrichTotal + b.nudges - (a.blocks + a.enrichTotal + a.nudges) ||
				a.tool.localeCompare(b.tool),
		);
```

(d) In the `totals` reducer, add `nudges` to both the accumulator object and the initial value:

```js
		const totals = rows.reduce(
			(t, r) => ({
				tool: "TOTAL",
				blocks: t.blocks + r.blocks,
				normalized: t.normalized + r.normalized,
				recovered: t.recovered + r.recovered,
				recoveryRate: 0,
				enrichMatched: t.enrichMatched + r.enrichMatched,
				enrichTotal: t.enrichTotal + r.enrichTotal,
				nudges: t.nudges + r.nudges,
			}),
			{ tool: "TOTAL", blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0, nudges: 0 },
		);
```

(e) In `formatReport`, add the column to the header and the row formatter:

```js
	const header = ["tool", "blocks", "norm", "recov", "recov%", "enrich", "nudge"].join("\t");
	const fmt = (r) => [r.tool, r.blocks, r.normalized, r.recovered, `${(r.recoveryRate * 100).toFixed(0)}%`, `${r.enrichMatched}/${r.enrichTotal}`, r.nudges].join("\t");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run test/report.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/scripts/report.mjs agent/extensions/pi-toolcall-guard/test/report.test.mjs
git commit -m "feat(guard): report native-tool nudge counts"
```

---

## Out of Scope (YAGNI)

- `ls`, `rg`, `head`/`tail`, `awk`, `echo >` redirects — lower value or higher false-positive risk; add later only if metrics show the model reaching for them.
- Rewriting bash calls into native calls (vs. blocking) — block+nudge is safer; arg translation is error-prone.
- Cross-tool recovery tracking for nudges — deliberately omitted (see Global Constraints).

## Self-Review

**Spec coverage:** cat→read (T1/T2), grep→grep (T1/T2), find→find (T1/T2), sed -i→edit (T1/T2), compound/unrelated pass-through (T1), block + metric (T2), never-throw (branch inside existing try, T2), report surfacing (T3). Covered.

**Placeholder scan:** no TBD/TODO; every code step has complete code; commands have expected output.

**Type consistency:** `NudgeResult { rule, tool, reason }` and `nudge(command)` are identical across Tasks 1-2; the `nudge` metric `{ kind, toolName, rule, tool }` matches between metrics.ts (T2), index.ts record call (T2), and report.mjs aggregation (T3); the `nudges` row field is named identically in report.mjs and its test (T3).

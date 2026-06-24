# Stream-Interrupt (real-time prose rule) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `pi-toolcall-guard` watch the assistant's streaming output and, on the first appearance of a prose-scoped rule's keyword, abort the turn and inject the rule's reminder so the model gets it in real time — at most once per assistant message and once per session.

**Architecture:** Reuse the already-ported, currently-dormant pieces — `RuleMonitor`'s `text`/`thinking` scope, `extractProse`, and `shouldInterrupt`. Add (1) a `RuleEngine.checkProse` method + a compact prose renderer, and (2) a small stateful `StreamWatcher` driven by the `message_update`/`turn_start` events that scans only the **tail** of the accumulated message (O(1) per token), calls `ctx.abort()` + `pi.sendUserMessage(..., followUp)` on a fresh interrupting match, and tracks a per-session fired-set. The tool-path engine is untouched; the stream path is additive and independently disableable.

**Tech Stack:** TypeScript (jiti, no build step), vitest, the pi extension API (`message_update`, `turn_start`, `ctx.abort`, `pi.sendUserMessage`) — all verified present in the installed pi.

## Global Constraints

- All code under `agent/extensions/pi-toolcall-guard/`. Extensionless relative imports (e.g. `from "./rules/engine"`), matching the existing extension.
- **This plan does NOT author any rules.** It builds the mechanism only. Prose rules (e.g. refusal/capability-denial) are out of scope and will be added separately as `.pi/guard-rules/*.md`.
- **v1 scope is interrupt-only on prose, once per session, in-memory.** No soft prose reminders, no `after-gap` repeat policy, no `pi.appendEntry` persistence. (`RuleMonitor`'s repeat machinery stays dormant; suppression lives in the watcher's in-memory fired-set.)
- The tool-path engine (`checkToolCall`, preflight, nudge, enrich) keeps its exact current behavior. The stream watcher must be gated by `PI_GUARD_STREAM` (default on; set `PI_GUARD_STREAM=0` to disable the fragile path without touching the rest).
- Never throw into an event handler — wrap the `message_update` handler body in try/catch returning void.
- Injected text is compact: `<system-reminder>[rule:NAME] BODY</system-reminder>`, one line — not the verbose `<system-interrupt>` template.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Path-scoped `git add` only (never `git add -A`/`.`). CRLF is this extension's established line-ending convention (not a defect).
- `npx vitest run` from `agent/extensions/pi-toolcall-guard/` is green after every task (baseline before this plan: 124/124).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/rules/render.ts` | + `renderStreamReminder(rule)` compact one-line block | modify |
| `src/rules/engine.ts` | + `checkProse(text, source)` → interrupt decision over prose | modify |
| `src/stream/watcher.ts` | `StreamWatcher`: tail scan, per-message abort guard, once-per-session fired-set, abort+inject orchestration | create |
| `src/metrics.ts` | + `stream` event variant | modify |
| `index.ts` | subscribe `message_update`/`turn_start`, wire watcher, enable flag | modify |
| `scripts/report.mjs` | + `streamInterrupts` counter/column | modify |

---

### Task 1: `checkProse` on RuleEngine + compact prose renderer

Add the prose-matching entry point to the engine and a compact renderer. Reuses `monitor.check(text, {source})`, `shouldInterrupt`, `dedupeByName` — all already present.

**Files:**
- Modify: `agent/extensions/pi-toolcall-guard/src/rules/render.ts`
- Modify: `agent/extensions/pi-toolcall-guard/src/rules/engine.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/rules/engine.test.ts` (extend)

**Interfaces:**
- Consumes: `RuleMonitor`, `shouldInterrupt`, `dedupeByName`, `Rule`, `TtsrSettings` (already imported by engine.ts).
- Produces: `renderStreamReminder(rule: Rule, filePath?: string): string`; `RuleEngine.checkProse(text: string, source: "text" | "thinking"): { text: string; ruleNames: string[] } | undefined`.

- [ ] **Step 1: Write the failing tests** — append to `test/rules/engine.test.ts`:

```ts
import { renderStreamReminder } from "../../src/rules/render";

describe("renderStreamReminder", () => {
	it("renders a compact one-line system-reminder with the rule name and body", () => {
		const out = renderStreamReminder({ name: "no-refuse", content: "Attempt the task.", condition: ["x"] });
		expect(out).toBe("<system-reminder>[rule:no-refuse] Attempt the task.</system-reminder>");
		expect(out).not.toContain("\n");
	});
});

describe("RuleEngine.checkProse", () => {
	const refuse: Rule = { name: "no-refuse", content: "Attempt the task.", condition: ["I cannot help"], scope: ["text"], interruptMode: "always" };
	const softProse: Rule = { name: "note", content: "noted", condition: ["whatever"], scope: ["text"] }; // default => never => not interrupting

	it("returns an interrupt decision for a matching always-rule in text", () => {
		const engine = new RuleEngine([refuse], DEFAULT_SETTINGS);
		const d = engine.checkProse("...sorry, I cannot help with that", "text");
		expect(d?.ruleNames).toEqual(["no-refuse"]);
		expect(d?.text).toContain("<system-reminder>[rule:no-refuse]");
	});

	it("ignores a non-interrupting (soft) prose match", () => {
		const engine = new RuleEngine([softProse], DEFAULT_SETTINGS);
		expect(engine.checkProse("whatever you say", "text")).toBeUndefined();
	});

	it("returns undefined for no match, empty text, or no rules", () => {
		const engine = new RuleEngine([refuse], DEFAULT_SETTINGS);
		expect(engine.checkProse("all good here", "text")).toBeUndefined();
		expect(engine.checkProse("", "text")).toBeUndefined();
		expect(new RuleEngine([], DEFAULT_SETTINGS).checkProse("I cannot help", "text")).toBeUndefined();
	});

	it("does not match a text rule against the thinking source it isn't scoped to", () => {
		const engine = new RuleEngine([refuse], DEFAULT_SETTINGS); // scope:["text"] only
		expect(engine.checkProse("I cannot help", "thinking")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/rules/engine.test.ts`
Expected: FAIL — `renderStreamReminder` not exported; `checkProse` not a function.

- [ ] **Step 3: Add `renderStreamReminder` to `render.ts`**

Append to `src/rules/render.ts` (it already exports `renderInterrupt`, `renderToolReminder`, `renderMany`, `shouldInterrupt`):

```ts
/** Compact one-line reminder for stream interrupts (kept short to spare context). */
export function renderStreamReminder(rule: Rule, _filePath?: string): string {
	return `<system-reminder>[rule:${rule.name}] ${rule.content.trim()}</system-reminder>`;
}
```

- [ ] **Step 4: Add `checkProse` to `engine.ts`**

In `src/rules/engine.ts`, add `renderStreamReminder` to the existing import from `./render`, then add the method to the `RuleEngine` class (alongside `checkToolCall`):

```ts
	/**
	 * Check a prose snapshot (a tail slice of the streaming assistant message).
	 * Returns a compact interrupt decision only for rules whose interrupt mode
	 * fires on this prose source; soft prose matches are ignored in v1.
	 */
	checkProse(text: string, source: "text" | "thinking"): { text: string; ruleNames: string[] } | undefined {
		if (!this.#monitor.hasRules() || text.length === 0) {
			return undefined;
		}
		const matches = this.#monitor.check(text, { source });
		const interrupting = matches.filter((rule) => shouldInterrupt(rule, source, this.#settings));
		if (interrupting.length === 0) {
			return undefined;
		}
		const rules = dedupeByName(interrupting);
		return { text: renderMany(renderStreamReminder, rules), ruleNames: rules.map((r) => r.name) };
	}
```

(`renderMany`, `shouldInterrupt`, `dedupeByName` are already imported in engine.ts; just add `renderStreamReminder` to the `./render` import line.)

- [ ] **Step 5: Run tests, then full suite**

Run: `npx vitest run test/rules/engine.test.ts` → PASS.
Run: `npx vitest run` → PASS (124 + new).

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/rules/render.ts \
        agent/extensions/pi-toolcall-guard/src/rules/engine.ts \
        agent/extensions/pi-toolcall-guard/test/rules/engine.test.ts
git commit -m "feat(guard): RuleEngine.checkProse + compact stream reminder"
```

---

### Task 2: `StreamWatcher` (tail scan + abort-once + once-per-session)

The stateful driver. Pure and unit-testable: it takes the streaming `message`, a `check` function, and an `actions` sink — no real pi needed.

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/stream/watcher.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/stream/watcher.test.ts`

**Interfaces:**
- Consumes: `extractProse` from `../rules/extract`.
- Produces:
  - `const STREAM_WINDOW = 120`
  - `type ProseCheck = (text: string, source: "text" | "thinking") => { text: string; ruleNames: string[] } | undefined`
  - `interface StreamActions { abort(): void; inject(text: string): void; notify?(message: string): void; record?(rule: string, source: "text" | "thinking"): void }`
  - `class StreamWatcher` with `constructor(window?: number)`, `onTurnStart(): void`, `onMessageUpdate(message: unknown, check: ProseCheck, actions: StreamActions): string[] | null`

- [ ] **Step 1: Write the failing test** — create `test/stream/watcher.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { StreamWatcher, type ProseCheck } from "../../src/stream/watcher";

function msg(text: string) {
	return { content: [{ type: "text", text }] };
}
function actions() {
	return { abort: vi.fn(), inject: vi.fn(), notify: vi.fn(), record: vi.fn() };
}
// check that fires for any text containing "banana"
const bananaCheck: ProseCheck = (text) =>
	text.includes("banana") ? { text: "<system-reminder>[rule:b] no banana</system-reminder>", ruleNames: ["b"] } : undefined;

describe("StreamWatcher", () => {
	it("aborts and injects on the first matching delta", () => {
		const w = new StreamWatcher();
		const a = actions();
		const fired = w.onMessageUpdate(msg("here is a banana now"), bananaCheck, a);
		expect(fired).toEqual(["b"]);
		expect(a.abort).toHaveBeenCalledTimes(1);
		expect(a.inject).toHaveBeenCalledWith("<system-reminder>[rule:b] no banana</system-reminder>");
		expect(a.record).toHaveBeenCalledWith("b", "text");
	});

	it("does nothing for a non-matching delta", () => {
		const w = new StreamWatcher();
		const a = actions();
		expect(w.onMessageUpdate(msg("apples and oranges"), bananaCheck, a)).toBeNull();
		expect(a.abort).not.toHaveBeenCalled();
	});

	it("aborts at most once per message (no second abort on a later delta)", () => {
		const w = new StreamWatcher();
		const a = actions();
		w.onMessageUpdate(msg("banana one"), bananaCheck, a);
		w.onMessageUpdate(msg("banana one banana two"), bananaCheck, a);
		expect(a.abort).toHaveBeenCalledTimes(1);
	});

	it("re-arms after onTurnStart but stays suppressed once per session", () => {
		const w = new StreamWatcher();
		const a = actions();
		w.onMessageUpdate(msg("banana"), bananaCheck, a); // fires, marks "b" fired
		w.onTurnStart(); // new turn: per-message guard resets
		const second = w.onMessageUpdate(msg("banana again"), bananaCheck, a);
		expect(second).toBeNull(); // "b" already fired this session
		expect(a.abort).toHaveBeenCalledTimes(1);
	});

	it("only scans the tail window, so an early match that scrolled out is missed", () => {
		const w = new StreamWatcher(10); // tiny window
		const a = actions();
		// "banana" is at the start; tail of 10 chars is "...four five" — no banana
		const long = "banana " + "x".repeat(40);
		expect(w.onMessageUpdate(msg(long), bananaCheck, a)).toBeNull();
		expect(a.abort).not.toHaveBeenCalled();
	});

	it("scans thinking blocks too", () => {
		const w = new StreamWatcher();
		const a = actions();
		const fired = w.onMessageUpdate({ content: [{ type: "thinking", thinking: "I should mention banana" }] }, bananaCheck, a);
		expect(fired).toEqual(["b"]);
		expect(a.record).toHaveBeenCalledWith("b", "thinking");
	});
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/stream/watcher.test.ts`
Expected: FAIL — cannot resolve `../../src/stream/watcher`.

- [ ] **Step 3: Implement `src/stream/watcher.ts`**

```ts
import { extractProse } from "../rules/extract";

/** Tail length (chars) scanned per delta. Must exceed the longest expected match. */
export const STREAM_WINDOW = 120;

export type ProseCheck = (
	text: string,
	source: "text" | "thinking",
) => { text: string; ruleNames: string[] } | undefined;

export interface StreamActions {
	/** Abort the in-flight assistant turn. */
	abort(): void;
	/** Inject the reminder as a follow-up message. */
	inject(text: string): void;
	/** Optional UI notification. */
	notify?(message: string): void;
	/** Optional metric sink (called once per fired rule). */
	record?(rule: string, source: "text" | "thinking"): void;
}

/**
 * Watches the streaming assistant message and interrupts on the first prose
 * rule hit. Scans only the tail of the accumulated text (O(1) per token).
 * Stateful: at most one abort per message (reset via onTurnStart) and at most
 * one fire per rule per session (in-memory fired-set). Reactive by nature —
 * the keyword's tokens have already streamed by the time we abort.
 */
export class StreamWatcher {
	readonly #window: number;
	readonly #fired = new Set<string>();
	#abortedThisMessage = false;

	constructor(window: number = STREAM_WINDOW) {
		this.#window = window;
	}

	/** Reset the per-message abort guard. Wire to turn_start. */
	onTurnStart(): void {
		this.#abortedThisMessage = false;
	}

	/**
	 * Inspect the current streaming snapshot. Returns the rule names that fired
	 * (and triggered abort+inject), or null if nothing fired.
	 */
	onMessageUpdate(message: unknown, check: ProseCheck, actions: StreamActions): string[] | null {
		if (this.#abortedThisMessage) {
			return null;
		}
		const prose = extractProse(message as Parameters<typeof extractProse>[0]);
		for (const [source, content] of [
			["text", prose.text],
			["thinking", prose.thinking],
		] as Array<["text" | "thinking", string]>) {
			if (content.length === 0) {
				continue;
			}
			const decision = check(content.slice(-this.#window), source);
			if (!decision) {
				continue;
			}
			const fresh = decision.ruleNames.filter((name) => !this.#fired.has(name));
			if (fresh.length === 0) {
				continue; // every matched rule already fired this session
			}
			this.#abortedThisMessage = true;
			for (const name of fresh) {
				this.#fired.add(name);
			}
			actions.abort();
			actions.inject(decision.text);
			actions.notify?.(`stream interrupt: ${fresh.join(", ")}`);
			for (const name of fresh) {
				actions.record?.(name, source);
			}
			return fresh;
		}
		return null;
	}
}
```

- [ ] **Step 4: Run tests, then full suite**

Run: `npx vitest run test/stream/watcher.test.ts` → PASS (6 cases).
Run: `npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/stream/watcher.ts \
        agent/extensions/pi-toolcall-guard/test/stream/watcher.test.ts
git commit -m "feat(guard): StreamWatcher tail-scan + abort-once + once-per-session"
```

---

### Task 3: Wire the watcher into the guard + `stream` metric + enable flag

Subscribe `message_update`/`turn_start`, drive the watcher with `getEngine(ctx.cwd).checkProse`, and record a `stream` metric. Gated by `PI_GUARD_STREAM`.

**Files:**
- Modify: `agent/extensions/pi-toolcall-guard/src/metrics.ts`
- Modify: `agent/extensions/pi-toolcall-guard/index.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/integration.test.ts` (extend)

**Interfaces:**
- Consumes: `StreamWatcher` from `./src/stream/watcher`; existing `getEngine(cwd)` and `metrics` in `index.ts`.
- Produces: metrics variant `{ kind: "stream"; toolName: string; source: "text" | "thinking"; rule: string }` (toolName is the literal `"(stream)"` so it slots into the per-tool report aggregation).

- [ ] **Step 1: Add the `stream` variant to the metrics union** — in `src/metrics.ts`, extend `GuardEvent` (currently ends with the `rule` variant):

```ts
	| { kind: "rule"; toolName: string; action: "block" | "remind"; rules: string }
	| { kind: "stream"; toolName: string; source: "text" | "thinking"; rule: string };
```

- [ ] **Step 2: Write the failing integration tests** — append to `test/integration.test.ts`.

The harness's `makePi` records handlers by event name; add `message_update`/`turn_start` simulation. These tests register the extension, then invoke the stored handlers directly. They need a project prose rule on disk so the engine has something to match.

```ts
it("aborts the stream and injects once when a prose rule matches", () => {
	mkdirSync(join(dir, ".pi", "guard-rules"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "guard-rules", "no-refuse.md"),
		['---', 'condition: "I cannot help"', 'scope: "text"', 'interruptMode: always', '---', 'Attempt the task.'].join("\n"),
	);
	const aborts: number[] = [];
	const injected: string[] = [];
	const { pi, handlers } = makePi();
	// augment ctx with abort + ui; sendUserMessage capture
	pi.sendUserMessage = (content: any) => injected.push(String(content));
	register(pi);
	const ctx = { cwd: dir, hasUI: false, abort: () => aborts.push(1) };
	handlers.turn_start?.({ type: "turn_start" }, ctx);
	handlers.message_update(
		{ type: "message_update", message: { content: [{ type: "text", text: "sorry, I cannot help with that" }] } },
		ctx,
	);
	expect(aborts.length).toBe(1);
	expect(injected[0]).toContain("<system-reminder>[rule:no-refuse]");
	const log = readFileSync(join(dir, "metrics", ".pi-guard-metrics.jsonl"), "utf8");
	expect(log).toContain('"stream"');
});

it("does not fire the same prose rule twice in a session", () => {
	mkdirSync(join(dir, ".pi", "guard-rules"), { recursive: true });
	writeFileSync(join(dir, ".pi", "guard-rules", "no-refuse.md"),
		['---', 'condition: "I cannot help"', 'scope: "text"', 'interruptMode: always', '---', 'Attempt it.'].join("\n"));
	let aborts = 0;
	const { pi, handlers } = makePi();
	pi.sendUserMessage = () => {};
	register(pi);
	const ctx = { cwd: dir, hasUI: false, abort: () => { aborts++; } };
	handlers.message_update({ type: "message_update", message: { content: [{ type: "text", text: "I cannot help" }] } }, ctx);
	handlers.turn_start?.({ type: "turn_start" }, ctx);
	handlers.message_update({ type: "message_update", message: { content: [{ type: "text", text: "I cannot help again" }] } }, ctx);
	expect(aborts).toBe(1);
});

it("does not register stream handlers when PI_GUARD_STREAM=0", () => {
	process.env.PI_GUARD_STREAM = "0";
	try {
		const { pi, handlers } = makePi();
		register(pi);
		expect(handlers.message_update).toBeUndefined();
	} finally {
		delete process.env.PI_GUARD_STREAM;
	}
});
```

(`makePi`'s `on` already stores handlers by event name, so `handlers.message_update`/`handlers.turn_start` work once the extension subscribes them. `mkdirSync`/`writeFileSync`/`readFileSync`/`join` are already imported in this test file.)

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — no `message_update` handler registered; no `stream` log line.

- [ ] **Step 4: Wire `index.ts`**

Add the import near the others:

```ts
import { StreamWatcher } from "./src/stream/watcher";
```

After the existing `pendingReminders`/`getEngine` block and the `tool_result` handler registration (placement is not load-bearing, but keep it after `getEngine` is defined), add:

```ts
	// Real-time stream interrupt (prose rules). Best-effort and gated: disable
	// with PI_GUARD_STREAM=0. Reactive — the keyword has already streamed by the
	// time we can abort; we abort the turn and re-inject the reminder.
	if (process.env.PI_GUARD_STREAM !== "0") {
		const watcher = new StreamWatcher();
		pi.on("turn_start", () => watcher.onTurnStart());
		pi.on("message_update", (event, ctx) => {
			try {
				const engine = getEngine(ctx.cwd);
				watcher.onMessageUpdate(
					event.message,
					(text, source) => engine.checkProse(text, source),
					{
						abort: () => ctx.abort(),
						inject: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
						notify: ctx.hasUI ? (m) => ctx.ui.notify(`[guard] ${m}`, "warning") : undefined,
						record: (rule, source) =>
							metrics.record({ kind: "stream", toolName: "(stream)", source, rule }),
					},
				);
			} catch {
				// Never throw into the stream loop.
			}
		});
	}
```

- [ ] **Step 5: Run tests, then full suite**

Run: `npx vitest run test/integration.test.ts` → PASS (existing + 3 new).
Run: `npx vitest run` → PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/metrics.ts \
        agent/extensions/pi-toolcall-guard/index.ts \
        agent/extensions/pi-toolcall-guard/test/integration.test.ts
git commit -m "feat(guard): wire StreamWatcher into message_update with stream metric"
```

---

### Task 4: Report — stream interrupt count

Surface stream interrupts in `report.mjs`, mirroring the `nudges` counter.

**Files:**
- Modify: `agent/extensions/pi-toolcall-guard/scripts/report.mjs`
- Test: `agent/extensions/pi-toolcall-guard/test/report.test.mjs` (extend)

**Interfaces:**
- Consumes: the `{ kind: "stream"; toolName: "(stream)"; source; rule }` events from Task 3.

- [ ] **Step 1: Write the failing test** — append to `test/report.test.mjs`:

```js
describe("report aggregation — stream events", () => {
	it("counts stream interrupts per tool bucket and in totals", () => {
		const text = [
			JSON.stringify({ kind: "stream", toolName: "(stream)", source: "text", rule: "no-refuse" }),
			JSON.stringify({ kind: "stream", toolName: "(stream)", source: "thinking", rule: "no-guess" }),
		].join("\n");
		const { rows, totals } = aggregate(parseEvents(text));
		const s = rows.find((r) => r.tool === "(stream)");
		expect(s.streamInterrupts).toBe(2);
		expect(totals.streamInterrupts).toBe(2);
	});
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/report.test.mjs`
Expected: FAIL — `streamInterrupts` is `undefined`.

- [ ] **Step 3: Add the counter to `report.mjs`** — four edits mirroring `nudges`/`ruleBlocks`:

(a) per-tool row initializer — add `streamInterrupts: 0`:
```js
			r = { tool, blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0, nudges: 0, ruleBlocks: 0, ruleReminds: 0, streamInterrupts: 0 };
```

(b) event loop — add after the `rule` branch:
```js
			else if (e.kind === "stream") r.streamInterrupts++;
```

(c) totals reducer — add to the accumulator object AND the initial object:
```js
				ruleReminds: t.ruleReminds + r.ruleReminds,
				streamInterrupts: t.streamInterrupts + r.streamInterrupts,
```
and in the initial seed object:
```js
			{ tool: "TOTAL", blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0, nudges: 0, ruleBlocks: 0, ruleReminds: 0, streamInterrupts: 0 },
```

(d) `formatReport` — add a `stream` column to header and row:
```js
	const header = ["tool", "blocks", "norm", "recov", "recov%", "enrich", "nudge", "rule b/r", "stream"].join("\t");
	const fmt = (r) => [r.tool, r.blocks, r.normalized, r.recovered, `${(r.recoveryRate * 100).toFixed(0)}%`, `${r.enrichMatched}/${r.enrichTotal}`, r.nudges, `${r.ruleBlocks}/${r.ruleReminds}`, r.streamInterrupts].join("\t");
```

- [ ] **Step 4: Run tests, then full suite**

Run: `npx vitest run test/report.test.mjs` → PASS.
Run: `npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/scripts/report.mjs \
        agent/extensions/pi-toolcall-guard/test/report.test.mjs
git commit -m "feat(guard): report stream interrupt counts"
```

---

## Out of scope (deliberate)

- **Any prose rules** — the mechanism only. Rules ship separately in `.pi/guard-rules/*.md`.
- **Soft prose reminders** (matching prose without interrupting) — v1 is interrupt-only. A non-interrupting prose rule is simply ignored by `checkProse`.
- **`after-gap` re-firing and cross-session persistence** — once-per-session is in-memory; `RuleMonitor`'s repeat machinery and `pi.appendEntry` stay unused.
- **Anchored prose patterns** — a rule using `^` would bind to the window edge on a tail slice, not the message start; document this as a rule-authoring constraint when rules are written (no code handling here).

## Self-Review notes

- **Spec coverage:** mechanism = checkProse+renderer (Task 1) + StreamWatcher (Task 2) + event wiring/metric/flag (Task 3) + report (Task 4). Tail-window O(1) scan, abort-once-per-message, once-per-session, enable flag, never-throw all covered. Reuses dormant `extractProse`/`text`-`thinking` scope/`shouldInterrupt` (no new matcher).
- **Type consistency:** `ProseCheck` return shape `{ text, ruleNames }` matches `RuleEngine.checkProse`'s return exactly; `StreamActions.record(rule, source)` matches the `stream` metric fields `{ rule, source }`; `renderStreamReminder(rule, _filePath?)` matches `renderMany`'s `(rule, filePath?) => string` signature. Metric `toolName: "(stream)"` is consistent between Task 3 (emit) and Task 4 (aggregate).
- **Placeholder scan:** every code step is complete; no TBD/“similar to”.

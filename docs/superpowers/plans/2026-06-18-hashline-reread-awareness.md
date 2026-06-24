# Hashline Re-read Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hashline `read` tool aware of re-reads — when the model re-reads a file it already read this session, return an "unchanged, reuse your anchors" notice or an anchored diff of what changed, instead of the full content again.

**Architecture:** A new pure module `src/reread.ts` holds the decision state-machine and the notice/diff rendering (reusing the existing anchored `generateDiffString` from `edit-diff.ts`). `src/read.ts` owns a session-scoped `Map` of last-read content per absolute path (created in the `registerReadTool` closure) and consults it only for **full reads** (no `offset`/`limit`), behind an env flag. Windowed reads, first reads, and image reads are untouched.

**Tech Stack:** TypeScript (ESM), vitest, the `diff` package (already a dependency), xxhashjs (via existing `computeLineHash`).

## Global Constraints

- Re-read logic applies to **full reads only** — when both `params.offset` and `params.limit` are `undefined`. Any windowed read bypasses re-read entirely and does not mutate re-read state.
- **Anchor safety is non-negotiable:** the "unchanged" path withholds content only because the prior anchors are provably still valid (content is byte-identical); the "changed" path returns either an anchored diff (whose `+`/context lines carry current `LINE#HASH:` anchors) or the full preview. Never return content with stale or missing anchors.
- **Loop-break:** if the model re-reads an unchanged file *immediately after* an "unchanged" notice was emitted for it, return the full content that time (the notice did not satisfy the model). One stub, then full.
- Feature is on by default and disabled when `process.env.PI_HASHLINE_REREAD === "0"` (read once in the `registerReadTool` closure).
- All comparison uses the LF-normalized, BOM-stripped content (`normalizeToLF(stripBom(text).text)`), matching what `read` already computes as `normalized`.
- Notices are prefixed `[hashline] ` to match the extension's existing message voice.
- Line endings: LF in all source files. Commits are path-scoped (the repo has unrelated dirty files) and end with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Pure functions in `src/reread.ts` take state as an argument — no module-level mutable singletons (keeps tests isolated and the closure the single owner of state).

---

## File Structure

- `src/reread.ts` (new) — pure decision + rendering helpers, plus the stateful `applyReread` orchestrator. Owns the `RereadEntry`/`RereadState` types and the `REREAD_DIFF_MAX_LINES` budget.
- `src/read.ts` (modify) — create the per-session state Map + read the env flag in `registerReadTool`; consult `applyReread` for full reads before the final return.
- `test/core/reread.decide.test.ts` (new) — `countVisibleLines`, `decideReread`.
- `test/core/reread.render.test.ts` (new) — `renderUnchangedNotice`, `renderChangedNotice`.
- `test/core/reread.apply.test.ts` (new) — `applyReread` state transitions.
- `test/tools/read.reread.test.ts` (new) — end-to-end through the registered `read` tool.

---

### Task 1: Re-read decision helpers

**Files:**
- Create: `agent/extensions/pi-hashline-edit/src/reread.ts`
- Test: `agent/extensions/pi-hashline-edit/test/core/reread.decide.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type RereadEntry = { content: string; lastWasStub: boolean }`
  - `type RereadState = Map<string, RereadEntry>`
  - `const REREAD_DIFF_MAX_LINES: number` (value `80`)
  - `function countVisibleLines(text: string): number`
  - `type RereadAction = "first" | "stub" | "force-full" | "changed"`
  - `function decideReread(prev: RereadEntry | undefined, curr: string): RereadAction`

- [ ] **Step 1: Write the failing test**

Create `test/core/reread.decide.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
	countVisibleLines,
	decideReread,
	type RereadEntry,
} from "../../src/reread";

describe("countVisibleLines", () => {
	it("counts zero for empty content", () => {
		expect(countVisibleLines("")).toBe(0);
	});
	it("counts a single unterminated line", () => {
		expect(countVisibleLines("alpha")).toBe(1);
	});
	it("ignores a single trailing newline sentinel", () => {
		expect(countVisibleLines("alpha\n")).toBe(1);
	});
	it("counts two lines without trailing newline", () => {
		expect(countVisibleLines("alpha\nbeta")).toBe(2);
	});
	it("counts two lines with trailing newline", () => {
		expect(countVisibleLines("alpha\nbeta\n")).toBe(2);
	});
});

describe("decideReread", () => {
	const entry = (content: string, lastWasStub: boolean): RereadEntry => ({
		content,
		lastWasStub,
	});

	it("returns 'first' when there is no prior entry", () => {
		expect(decideReread(undefined, "x")).toBe("first");
	});
	it("returns 'stub' on identical content after a real render", () => {
		expect(decideReread(entry("x", false), "x")).toBe("stub");
	});
	it("returns 'force-full' on identical content after a stub", () => {
		expect(decideReread(entry("x", true), "x")).toBe("force-full");
	});
	it("returns 'changed' when content differs", () => {
		expect(decideReread(entry("x", false), "y")).toBe("changed");
	});
	it("returns 'changed' when content differs even after a stub", () => {
		expect(decideReread(entry("x", true), "y")).toBe("changed");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run test/core/reread.decide.test.ts`
Expected: FAIL — cannot resolve `../../src/reread`.

- [ ] **Step 3: Write minimal implementation**

Create `src/reread.ts`:

```ts
/**
 * Re-read awareness for the hashline read tool.
 *
 * Tracks the last FULL read (no offset/limit) of each path within a session so
 * that a re-read can be answered with an "unchanged, reuse your anchors" notice
 * or an anchored diff of what changed — instead of re-emitting the whole file.
 * State is passed in explicitly (owned by the read-tool closure) so this module
 * stays pure and testable.
 */

/** Memory of the last full read of one path. */
export type RereadEntry = { content: string; lastWasStub: boolean };
export type RereadState = Map<string, RereadEntry>;

/**
 * Above this many diff lines, a changed re-read shows the full file instead of
 * the diff: a large diff is no longer cheaper or clearer than a fresh read.
 */
export const REREAD_DIFF_MAX_LINES = 80;

/** Count rendered lines, ignoring a single trailing-newline sentinel. */
export function countVisibleLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

export type RereadAction = "first" | "stub" | "force-full" | "changed";

/**
 * Decide how to answer a full read given the prior entry for the same path.
 * - no prior entry        → "first"   (record and show full)
 * - identical, last real  → "stub"    (show the unchanged notice)
 * - identical, last stub  → "force-full" (loop-break: show full again)
 * - different             → "changed" (show diff or full)
 */
export function decideReread(
	prev: RereadEntry | undefined,
	curr: string,
): RereadAction {
	if (prev === undefined) return "first";
	if (prev.content === curr) return prev.lastWasStub ? "force-full" : "stub";
	return "changed";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run test/core/reread.decide.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-hashline-edit/src/reread.ts agent/extensions/pi-hashline-edit/test/core/reread.decide.test.ts
git commit -m "feat(hashline): re-read decision helpers"
```

---

### Task 2: Notice + anchored-diff rendering

**Files:**
- Modify: `agent/extensions/pi-hashline-edit/src/reread.ts`
- Test: `agent/extensions/pi-hashline-edit/test/core/reread.render.test.ts`

**Interfaces:**
- Consumes: `countVisibleLines`, `REREAD_DIFF_MAX_LINES` (Task 1); `generateDiffString(oldContent, newContent, contextLines?)` from `./edit-diff` (existing — returns `{ diff: string }` whose `+` and context lines carry current `LINE#HASH:` anchors).
- Produces:
  - `function renderUnchangedNotice(content: string): string`
  - `function renderChangedNotice(prev: string, curr: string, fullPreviewText: string, maxDiffLines?: number): { text: string; mode: "changed-diff" | "changed-full" }`

- [ ] **Step 1: Write the failing test**

Create `test/core/reread.render.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderChangedNotice, renderUnchangedNotice } from "../../src/reread";

const ANCHOR_RE = /\d+#[ZPMQVRWSNKTXJBYH]{2}:/;

describe("renderUnchangedNotice", () => {
	it("states the file is unchanged and reports the line count", () => {
		const text = renderUnchangedNotice("alpha\nbeta\n");
		expect(text).toContain("Unchanged since your last read");
		expect(text).toContain("2 lines");
	});
	it("tells the model its prior anchors are still valid", () => {
		const text = renderUnchangedNotice("alpha\n");
		expect(text.toLowerCase()).toContain("anchors are still valid");
	});
});

describe("renderChangedNotice", () => {
	it("returns an anchored diff for a small change", () => {
		const prev = "alpha\nbeta\ngamma\n";
		const curr = "alpha\nBETA\ngamma\n";
		const { text, mode } = renderChangedNotice(prev, curr, "FULL_PREVIEW");
		expect(mode).toBe("changed-diff");
		expect(text).toContain("Changed since your last read");
		expect(text).toContain("BETA");
		expect(text).toMatch(ANCHOR_RE);
		expect(text).not.toContain("FULL_PREVIEW");
	});

	it("falls back to the full preview when the diff exceeds the budget", () => {
		const prev = "a\nb\nc\nd\n";
		const curr = "A\nB\nC\nD\n";
		const { text, mode } = renderChangedNotice(prev, curr, "FULL_PREVIEW", 1);
		expect(mode).toBe("changed-full");
		expect(text).toContain("Changed substantially");
		expect(text).toContain("FULL_PREVIEW");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run test/core/reread.render.test.ts`
Expected: FAIL — `renderUnchangedNotice`/`renderChangedNotice` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/reread.ts` (add the import at the top, below the file header comment):

```ts
import { generateDiffString } from "./edit-diff";
```

Append these functions at the end of the file:

```ts
/** Notice emitted when a re-read finds byte-identical content. */
export function renderUnchangedNotice(content: string): string {
	return (
		`[hashline] Unchanged since your last read ` +
		`(${countVisibleLines(content)} lines, identical content). ` +
		`Your earlier LINE#HASH anchors are still valid — reuse them instead of re-reading.`
	);
}

/**
 * Notice emitted when a re-read finds different content. Prefers an anchored
 * diff (whose context/"+" lines carry current LINE#HASH anchors); falls back to
 * the full preview when the diff is large enough that a fresh read is clearer.
 */
export function renderChangedNotice(
	prev: string,
	curr: string,
	fullPreviewText: string,
	maxDiffLines: number = REREAD_DIFF_MAX_LINES,
): { text: string; mode: "changed-diff" | "changed-full" } {
	const { diff } = generateDiffString(prev, curr);
	const diffLineCount = diff.length === 0 ? 0 : diff.split("\n").length;
	if (diffLineCount > 0 && diffLineCount <= maxDiffLines) {
		return {
			mode: "changed-diff",
			text:
				`[hashline] Changed since your last read. Diff below — the ` +
				`LINE#HASH anchors on context and "+" lines are current; reuse them.\n\n` +
				diff,
		};
	}
	return {
		mode: "changed-full",
		text:
			`[hashline] Changed substantially since your last read ` +
			`(${diffLineCount} diff lines). Showing the full file with current anchors:\n\n` +
			fullPreviewText,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run test/core/reread.render.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-hashline-edit/src/reread.ts agent/extensions/pi-hashline-edit/test/core/reread.render.test.ts
git commit -m "feat(hashline): re-read unchanged notice and anchored-diff rendering"
```

---

### Task 3: Stateful `applyReread` orchestrator

**Files:**
- Modify: `agent/extensions/pi-hashline-edit/src/reread.ts`
- Test: `agent/extensions/pi-hashline-edit/test/core/reread.apply.test.ts`

**Interfaces:**
- Consumes: `RereadState`, `RereadEntry`, `decideReread`, `renderUnchangedNotice`, `renderChangedNotice`, `REREAD_DIFF_MAX_LINES` (Tasks 1-2).
- Produces:
  - `type RereadOutcome = { text: string; mode: "unchanged" | "changed-diff" | "changed-full" } | null`
  - `function applyReread(state: RereadState, absPath: string, curr: string, fullPreviewText: string, maxDiffLines?: number): RereadOutcome`
    - Returns `null` for "first" and "force-full" (caller emits the normal full preview); returns the notice otherwise. Always updates `state[absPath]`.

- [ ] **Step 1: Write the failing test**

Create `test/core/reread.apply.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyReread, type RereadState } from "../../src/reread";

describe("applyReread", () => {
	it("records the first read and returns null (caller shows full)", () => {
		const state: RereadState = new Map();
		const out = applyReread(state, "/f", "alpha\n", "PREVIEW");
		expect(out).toBeNull();
		expect(state.get("/f")).toEqual({ content: "alpha\n", lastWasStub: false });
	});

	it("emits an unchanged notice on the first identical re-read", () => {
		const state: RereadState = new Map();
		applyReread(state, "/f", "alpha\n", "PREVIEW");
		const out = applyReread(state, "/f", "alpha\n", "PREVIEW");
		expect(out?.mode).toBe("unchanged");
		expect(out?.text).toContain("Unchanged since your last read");
		expect(state.get("/f")?.lastWasStub).toBe(true);
	});

	it("breaks the loop: a second identical re-read after a stub returns null", () => {
		const state: RereadState = new Map();
		applyReread(state, "/f", "alpha\n", "PREVIEW"); // first  -> null
		applyReread(state, "/f", "alpha\n", "PREVIEW"); // second -> stub
		const out = applyReread(state, "/f", "alpha\n", "PREVIEW"); // third
		expect(out).toBeNull();
		expect(state.get("/f")?.lastWasStub).toBe(false);
	});

	it("emits a changed notice and updates stored content on change", () => {
		const state: RereadState = new Map();
		applyReread(state, "/f", "alpha\nbeta\n", "PREVIEW");
		const out = applyReread(state, "/f", "alpha\nBETA\n", "PREVIEW");
		expect(out?.mode).toBe("changed-diff");
		expect(out?.text).toContain("Changed since your last read");
		expect(state.get("/f")).toEqual({
			content: "alpha\nBETA\n",
			lastWasStub: false,
		});
	});

	it("isolates state by path", () => {
		const state: RereadState = new Map();
		applyReread(state, "/a", "x\n", "PREVIEW");
		const out = applyReread(state, "/b", "x\n", "PREVIEW");
		expect(out).toBeNull(); // /b is a first read, not a re-read of /a
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run test/core/reread.apply.test.ts`
Expected: FAIL — `applyReread` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/reread.ts`:

```ts
export type RereadOutcome =
	| { text: string; mode: "unchanged" | "changed-diff" | "changed-full" }
	| null;

/**
 * Consult and update re-read state for one full read. Returns the notice to
 * emit, or null when the caller should emit its normal full preview (first read
 * or loop-break). Always records the current content as the new baseline.
 */
export function applyReread(
	state: RereadState,
	absPath: string,
	curr: string,
	fullPreviewText: string,
	maxDiffLines: number = REREAD_DIFF_MAX_LINES,
): RereadOutcome {
	const prev = state.get(absPath);
	const action = decideReread(prev, curr);
	switch (action) {
		case "first":
		case "force-full":
			state.set(absPath, { content: curr, lastWasStub: false });
			return null;
		case "stub":
			state.set(absPath, { content: curr, lastWasStub: true });
			return { text: renderUnchangedNotice(curr), mode: "unchanged" };
		case "changed": {
			state.set(absPath, { content: curr, lastWasStub: false });
			const { text, mode } = renderChangedNotice(
				prev!.content,
				curr,
				fullPreviewText,
				maxDiffLines,
			);
			return { text, mode };
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run test/core/reread.apply.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-hashline-edit/src/reread.ts agent/extensions/pi-hashline-edit/test/core/reread.apply.test.ts
git commit -m "feat(hashline): stateful applyReread orchestrator with loop-break"
```

---

### Task 4: Wire re-read awareness into the read tool

**Files:**
- Modify: `agent/extensions/pi-hashline-edit/src/read.ts` (imports; `registerReadTool` closure; the `execute` return block at lines ~212-236)
- Test: `agent/extensions/pi-hashline-edit/test/tools/read.reread.test.ts`

**Interfaces:**
- Consumes: `applyReread`, `type RereadState` (Task 3); existing `normalizeToLF`/`stripBom`, `formatHashlineReadPreview`, `getFileSnapshot`.
- Produces: behavioral change to the registered `read` tool — full re-reads return notices; `details.reread` carries the mode when a notice is emitted.

- [ ] **Step 1: Write the failing test**

Create `test/tools/read.reread.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import register from "../../index";
import {
	getText,
	makeFakePiRegistry,
	makeToolContext,
	withTempFile,
} from "../support/fixtures";

vi.mock("../../src/file-kind", () => ({
	loadFileKindAndText: vi.fn(),
}));

import * as fileKindMod from "../../src/file-kind";

const ctxRead = (cwd: string, params: Record<string, unknown>) => {
	const { pi, getTool } = makeFakePiRegistry();
	register(pi);
	return { getTool, params, cwd };
};

describe("read tool re-read awareness", () => {
	beforeEach(() => {
		vi.mocked(fileKindMod.loadFileKindAndText).mockReset();
		delete process.env.PI_HASHLINE_REREAD;
	});
	afterEach(() => {
		delete process.env.PI_HASHLINE_REREAD;
	});

	it("emits an unchanged notice on an identical full re-read", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");

			const first = await read.execute("r1", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(first)).toContain(":alpha");

			const second = await read.execute("r2", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(second)).toContain("Unchanged since your last read");
			expect(getText(second)).not.toContain(":beta");
		});
	});

	it("shows full content again on the read after a stub (loop-break)", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");

			await read.execute("r1", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			await read.execute("r2", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd)); // stub
			const third = await read.execute("r3", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(third)).toContain(":alpha");
			expect(getText(third)).not.toContain("Unchanged since your last read");
		});
	});

	it("emits a changed notice when content differs", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValueOnce({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");
			await read.execute("r1", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));

			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValueOnce({
				kind: "text",
				text: "alpha\nBETA\n",
			});
			const second = await read.execute("r2", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(second)).toContain("Changed since your last read");
			expect(getText(second)).toContain("BETA");
		});
	});

	it("does not apply to windowed reads", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");

			const first = await read.execute("r1", { path: "a.txt", limit: 1 }, undefined, undefined, makeToolContext(cwd));
			expect(getText(first)).toContain(":alpha");
			const second = await read.execute("r2", { path: "a.txt", limit: 1 }, undefined, undefined, makeToolContext(cwd));
			expect(getText(second)).not.toContain("Unchanged since your last read");
			expect(getText(second)).toContain(":alpha");
		});
	});

	it("is disabled by PI_HASHLINE_REREAD=0", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			process.env.PI_HASHLINE_REREAD = "0";
			vi.mocked(fileKindMod.loadFileKindAndText).mockResolvedValue({
				kind: "text",
				text: "alpha\nbeta\n",
			});
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const read = getTool("read");

			await read.execute("r1", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			const second = await read.execute("r2", { path: "a.txt" }, undefined, undefined, makeToolContext(cwd));
			expect(getText(second)).not.toContain("Unchanged since your last read");
			expect(getText(second)).toContain(":alpha");
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run test/tools/read.reread.test.ts`
Expected: FAIL — the second identical read still returns full content (no "Unchanged" notice).

- [ ] **Step 3: Write minimal implementation**

In `src/read.ts`, add the import near the other `./` imports (after the `getFileSnapshot` import line):

```ts
import { applyReread, type RereadState } from "./reread";
```

In `registerReadTool`, immediately before `pi.registerTool({`, add the closure-scoped state and flag:

```ts
	// Session-scoped memory of the last full read of each path. Lives in the
	// closure so it is per-extension-instance and resets when pi restarts.
	const rereadState: RereadState = new Map();
	const rereadEnabled = process.env.PI_HASHLINE_REREAD !== "0";
```

Replace the final return block of `execute` (the `const previewText = ...` assignment through the closing `};` of the returned object) with:

```ts
			const previewText =
				file.hadUtf8DecodeErrors === true
					? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
					: preview.text;

			const baseDetails = {
				truncation: preview.truncation,
				// snapshotId remains in details for host UI (e.g. "file changed since
				// last view"). It is NOT echoed in text — the LLM no longer needs it.
				snapshotId: snapshot.snapshotId,
				...(preview.nextOffset !== undefined
					? { nextOffset: preview.nextOffset }
					: {}),
				// Phase 2 C — host-only observability. Truncated reads usually mean
				// a follow-up read with `offset = next_offset` is coming.
				metrics: {
					truncated: !!preview.truncation,
					...(preview.nextOffset !== undefined
						? { next_offset: preview.nextOffset }
						: {}),
				},
			};

			// Re-read awareness (full reads only). On a re-read of a path read
			// earlier this session, return an "unchanged, reuse your anchors"
			// notice or an anchored diff instead of the whole file. Anchors stay
			// valid in both cases. Disabled with PI_HASHLINE_REREAD=0.
			const isFullRead =
				params.offset === undefined && params.limit === undefined;
			if (rereadEnabled && isFullRead) {
				const outcome = applyReread(
					rereadState,
					absolutePath,
					normalized,
					previewText,
				);
				if (outcome) {
					return {
						content: [{ type: "text", text: outcome.text }],
						details: { ...baseDetails, reread: outcome.mode },
					};
				}
			}

			return {
				content: [{ type: "text", text: previewText }],
				details: baseDetails,
			};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run test/tools/read.reread.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `cd agent/extensions/pi-hashline-edit && npx vitest run && npm run typecheck`
Expected: all tests pass; `tsc --noEmit` clean. (If `tsc` flags the differing `details` shapes across the two returns, that is expected union inference and acceptable; only fix if it is an actual error.)

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-hashline-edit/src/read.ts agent/extensions/pi-hashline-edit/test/tools/read.reread.test.ts
git commit -m "feat(hashline): wire re-read awareness into the read tool"
```

---

## Out of Scope (YAGNI)

- Windowed (offset/limit) re-read diffing — bypassed entirely.
- Cross-session persistence of read history — state is per session by design.
- Prompt/README documentation of the notices — the notice text is self-describing; defer any prompt-doc change until after live testing confirms the wording.
- Any change to the `edit` tool or to `generateDiffString` — reused as-is.

## Self-Review

**Spec coverage:** unchanged notice (Task 2/4), anchored diff on change (Task 2/4), full-read-only gating (Task 4), loop-break (Task 3), env disable (Task 4), anchor safety (diff reuse + identical-content invariant). All covered.

**Placeholder scan:** no TBD/TODO; every code step has complete code; commands have expected output.

**Type consistency:** `RereadEntry`/`RereadState`/`RereadAction`/`RereadOutcome`, `applyReread`, `decideReread`, `renderUnchangedNotice`, `renderChangedNotice`, `countVisibleLines`, `REREAD_DIFF_MAX_LINES` are named identically across Tasks 1-4. `applyReread` signature `(state, absPath, curr, fullPreviewText, maxDiffLines?)` matches its call site in Task 4.

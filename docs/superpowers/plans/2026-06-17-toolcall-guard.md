# Tool-Call Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic pi extension that (1) preflights path-bearing tool calls — repairing trivially-malformed paths in place and blocking nonexistent ones with a near-match suggestion — and (2) rewrites failed tool results into actionable next-step hints, so 2nd-tier models (Sonnet, deepseek-v4-flash) waste fewer turns on bad calls and opaque errors.

**Architecture:** One extension, `pi-toolcall-guard`, mirroring the structure of the existing `pi-context-collapse` sibling. It subscribes to two host hooks: `tool_call` (fires *after* schema validation; can mutate `event.input` in place or return `{ block, reason }`) for the preflight guard, and `tool_result` (only when `isError`) for the error enricher. All logic is pure and deterministic — no model, no network. A best-effort JSONL metrics sink records blocks, normalizations, enrichments, and a rough recovery signal so effectiveness is measurable via `npm run report`.

**Tech Stack:** TypeScript (ESNext, bundler resolution), Node 24, vitest. No runtime dependencies (no SQLite — metrics are append-only JSONL). Types from `@earendil-works/pi-coding-agent` (devDependency).

## Global Constraints

- Platform is Windows 10; tests must pass under Bash (Git Bash) and the code must not assume POSIX-only path semantics. Use `node:path` for all path work.
- Pure and deterministic: no network, no model calls, no randomness. Same input → same output.
- Degrade to a no-op on any setup IO failure: if the metrics dir cannot be created, the extension entrypoint must return without throwing and without registering hooks.
- **Never silently substitute a *different* file.** Preflight may only normalize the *same* path (trim, strip surrounding quotes) when the normalized form exists. If the target does not exist, BLOCK with a suggestion — never redirect the call to a near-match automatically.
- Unknown tools (anything not in the known path-tool set) preflight to `pass` — never block a tool we don't model.
- The `tool_call` handler must never throw into the host: wrap its body so any internal error returns `undefined` (tool proceeds unguarded) rather than propagating (which blocks execution — see `agent-loop.js:188`).
- The enricher only ever runs on `isError` results and only rewrites the text; it never touches non-error results (those belong to `pi-context-collapse`).
- Metrics are best-effort and must never throw into the tool path (swallow IO errors), matching `pi-context-collapse/src/metrics.ts`.
- Default metrics dir is `~/.pi/guard`, overridable with `PI_GUARD_DIR`. This mirrors `PI_COLLAPSE_DIR`.
- Files are LF line endings (repo `.editorconfig`). Commits are path-scoped to `agent/extensions/pi-toolcall-guard/**` and end with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

```
agent/extensions/pi-toolcall-guard/
  package.json            — private, type:module, scripts: test/typecheck/report; no runtime deps
  tsconfig.json           — identical compilerOptions to pi-context-collapse
  index.ts                — entrypoint: wire tool_call + tool_result hooks, metrics, degrade-to-noop
  src/
    paths.ts              — PATH_TOOLS table; getPathArg(); normalizePathValue(); pathExists()
    suggest.ts            — levenshtein(); nearMatches() (sibling-dir fuzzy match)
    preflight.ts          — preflight(): pass | normalized | block
    enrich.ts             — RULES table; enrichError(): rule match → appended hint
    metrics.ts            — GuardEvent; Metrics (JSONL append, swallow errors)
  test/
    paths.test.ts
    suggest.test.ts
    preflight.test.ts
    enrich.test.ts
    integration.test.ts
  scripts/report.mjs      — aggregate blocks/normalizations/enrichments + recovery rate
  docs/acceptance.md      — live acceptance cases
```

**Module responsibilities:**
- `paths.ts` knows *which* arg of *which* tool is a path, and how to safely normalize a path string.
- `suggest.ts` is the only module that touches the filesystem to find near-matches; pure-math `levenshtein` lives here too.
- `preflight.ts` composes `paths` + `suggest` into a single decision. No host types.
- `enrich.ts` is a pure string→string rule table. No filesystem, no host types.
- `index.ts` is the only file that imports host types and wires hooks; it holds the cross-call recovery state.

---

## Task 1: Scaffold + metrics sink

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/package.json`
- Create: `agent/extensions/pi-toolcall-guard/tsconfig.json`
- Create: `agent/extensions/pi-toolcall-guard/src/metrics.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/metrics.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `type GuardEvent =`
    - `| { kind: "preflight"; outcome: "normalized" | "block"; toolName: string }`
    - `| { kind: "preflight_recovered"; toolName: string }`
    - `| { kind: "enrich"; matched: boolean; rule?: string; toolName: string }`
  - `class Metrics { constructor(path: string); record(e: GuardEvent): void }` — appends `{...e, ts}` as one JSON line; swallows IO errors.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pi-toolcall-guard",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "description": "Deterministic preflight path-guard and error-enricher for tool calls",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "report": "node scripts/report.mjs"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.2",
    "@sinclair/typebox": "^0.34.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (identical to the sibling extension)

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write the failing test** — `test/metrics.test.ts`

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Metrics } from "../src/metrics";

describe("Metrics", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "guard-metrics-")); });
	afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

	it("appends one JSON line per event with a ts field", () => {
		const path = join(dir, "m.jsonl");
		const m = new Metrics(path);
		m.record({ kind: "preflight", outcome: "block", toolName: "read" });
		m.record({ kind: "enrich", matched: true, rule: "enoent", toolName: "bash" });
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]);
		expect(first.kind).toBe("preflight");
		expect(first.outcome).toBe("block");
		expect(typeof first.ts).toBe("number");
	});

	it("swallows IO errors (path under a nonexistent dir) without throwing", () => {
		const m = new Metrics(join(dir, "missing-subdir", "m.jsonl"));
		expect(() => m.record({ kind: "preflight_recovered", toolName: "read" })).not.toThrow();
		expect(existsSync(join(dir, "missing-subdir"))).toBe(false);
	});
});
```

- [ ] **Step 4: Run the test, verify it fails**

Run: `cd agent/extensions/pi-toolcall-guard && npx vitest run test/metrics.test.ts`
Expected: FAIL — cannot find `../src/metrics`.

- [ ] **Step 5: Implement `src/metrics.ts`**

```ts
import { appendFileSync } from "node:fs";

export type GuardEvent =
	| { kind: "preflight"; outcome: "normalized" | "block"; toolName: string }
	| { kind: "preflight_recovered"; toolName: string }
	| { kind: "enrich"; matched: boolean; rule?: string; toolName: string };

/** Append-only JSONL metrics sink. Best-effort: never throws into the tool path. */
export class Metrics {
	constructor(private readonly path: string) {}

	record(event: GuardEvent): void {
		try {
			appendFileSync(this.path, `${JSON.stringify({ ...event, ts: Date.now() })}\n`);
		} catch {
			// metrics are best-effort; swallow IO errors so the guard never fails on logging
		}
	}
}
```

- [ ] **Step 6: Install deps, run the test, verify it passes**

Run: `cd agent/extensions/pi-toolcall-guard && npm install && npx vitest run test/metrics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/package.json agent/extensions/pi-toolcall-guard/package-lock.json agent/extensions/pi-toolcall-guard/tsconfig.json agent/extensions/pi-toolcall-guard/src/metrics.ts agent/extensions/pi-toolcall-guard/test/metrics.test.ts
git commit -m "feat(guard): scaffold extension + JSONL metrics sink"
```

---

## Task 2: Path-arg extraction and normalization

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/paths.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PathToolMeta { optional: boolean; isWrite: boolean }`
  - `const PATH_TOOLS: Record<string, PathToolMeta>` — keys `read`, `edit`, `write`, `ls`, `grep`, `find`.
  - `function getPathArg(toolName: string, input: Record<string, unknown>): { key: string; value: string } | null` — returns the first present string-valued path arg (`path` then `file_path`) for a known path tool; `null` for unknown tools or when no path arg is present.
  - `function normalizePathValue(raw: string): string` — trims and strips a single layer of matching surrounding quotes. No separator rewriting.
  - `function pathExists(resolved: string): boolean` — `fs.existsSync` wrapper.

- [ ] **Step 1: Write the failing test** — `test/paths.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { getPathArg, normalizePathValue, PATH_TOOLS } from "../src/paths";

describe("getPathArg", () => {
	it("returns the 'path' arg for read", () => {
		expect(getPathArg("read", { path: "src/a.ts" })).toEqual({ key: "path", value: "src/a.ts" });
	});
	it("falls back to 'file_path' when 'path' is absent", () => {
		expect(getPathArg("edit", { file_path: "src/b.ts" })).toEqual({ key: "file_path", value: "src/b.ts" });
	});
	it("returns null for an unknown tool", () => {
		expect(getPathArg("expand", { path: "x" })).toBeNull();
	});
	it("returns null when the known tool has no string path arg (optional tools)", () => {
		expect(getPathArg("grep", { pattern: "foo" })).toBeNull();
	});
	it("ignores non-string path values", () => {
		expect(getPathArg("read", { path: 123 as unknown as string })).toBeNull();
	});
});

describe("normalizePathValue", () => {
	it("trims whitespace", () => {
		expect(normalizePathValue("  src/a.ts  ")).toBe("src/a.ts");
	});
	it("strips a single layer of matching double quotes", () => {
		expect(normalizePathValue('"src/a.ts"')).toBe("src/a.ts");
	});
	it("strips a single layer of matching single quotes", () => {
		expect(normalizePathValue("'src/a.ts'")).toBe("src/a.ts");
	});
	it("leaves an unquoted path unchanged", () => {
		expect(normalizePathValue("src/a.ts")).toBe("src/a.ts");
	});
	it("does not strip mismatched quotes", () => {
		expect(normalizePathValue("\"src/a.ts'")).toBe("\"src/a.ts'");
	});
});

describe("PATH_TOOLS", () => {
	it("marks write as a write tool and read as not", () => {
		expect(PATH_TOOLS.write.isWrite).toBe(true);
		expect(PATH_TOOLS.read.isWrite).toBe(false);
	});
	it("marks grep/find/ls path as optional", () => {
		expect(PATH_TOOLS.grep.optional).toBe(true);
		expect(PATH_TOOLS.read.optional).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run test/paths.test.ts`
Expected: FAIL — cannot find `../src/paths`.

- [ ] **Step 3: Implement `src/paths.ts`**

```ts
import { existsSync } from "node:fs";

export interface PathToolMeta {
	/** The path arg is optional (e.g. grep/find/ls default to cwd). */
	optional: boolean;
	/** The tool writes to the path, so the target itself need not pre-exist. */
	isWrite: boolean;
}

/** Built-in tools whose primary path arg can be reality-checked before execution. */
export const PATH_TOOLS: Record<string, PathToolMeta> = {
	read: { optional: false, isWrite: false },
	edit: { optional: false, isWrite: false },
	write: { optional: false, isWrite: true },
	ls: { optional: true, isWrite: false },
	grep: { optional: true, isWrite: false },
	find: { optional: true, isWrite: false },
};

/** Candidate arg names that carry a path, in priority order. */
const PATH_KEYS = ["path", "file_path"] as const;

export function getPathArg(
	toolName: string,
	input: Record<string, unknown>,
): { key: string; value: string } | null {
	if (!PATH_TOOLS[toolName]) return null;
	for (const key of PATH_KEYS) {
		const v = input[key];
		if (typeof v === "string" && v.length > 0) return { key, value: v };
	}
	return null;
}

export function normalizePathValue(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

export function pathExists(resolved: string): boolean {
	return existsSync(resolved);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/paths.ts agent/extensions/pi-toolcall-guard/test/paths.test.ts
git commit -m "feat(guard): path-arg extraction and safe normalization"
```

---

## Task 3: Near-match suggestions

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/suggest.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/suggest.test.ts`

**Interfaces:**
- Consumes: nothing (pure + reads the filesystem directly).
- Produces:
  - `function levenshtein(a: string, b: string): number` — classic edit distance.
  - `function nearMatches(value: string, cwd: string, max?: number): string[]` — resolves `value` against `cwd`, looks in its parent directory, and returns up to `max` (default 3) sibling entries whose basename is within the edit-distance threshold of the target basename, ranked closest-first, expressed as cwd-relative POSIX paths. Returns `[]` when the parent directory does not exist.

- [ ] **Step 1: Write the failing test** — `test/suggest.test.ts`

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { levenshtein, nearMatches } from "../src/suggest";

describe("levenshtein", () => {
	it("is 0 for identical strings", () => { expect(levenshtein("abc", "abc")).toBe(0); });
	it("counts single substitutions", () => { expect(levenshtein("util", "utils")).toBe(1); });
	it("counts transposed-length edits", () => { expect(levenshtein("kitten", "sitting")).toBe(3); });
});

describe("nearMatches", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "guard-suggest-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "utils.ts"), "");
		writeFileSync(join(dir, "src", "index.ts"), "");
	});
	afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

	it("suggests the closest sibling for a near-miss basename", () => {
		const out = nearMatches("src/util.ts", dir);
		expect(out).toContain("src/utils.ts");
	});

	it("ranks the closest match first", () => {
		const out = nearMatches("src/utild.ts", dir);
		expect(out[0]).toBe("src/utils.ts");
	});

	it("returns [] when the parent directory does not exist", () => {
		expect(nearMatches("nope/whatever.ts", dir)).toEqual([]);
	});

	it("returns [] when nothing is close enough", () => {
		expect(nearMatches("src/completely-different-name.ts", dir)).toEqual([]);
	});

	it("uses forward slashes regardless of platform", () => {
		const out = nearMatches("src/util.ts", dir);
		expect(out.every((p) => !p.includes("\\"))).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run test/suggest.test.ts`
Expected: FAIL — cannot find `../src/suggest`.

- [ ] **Step 3: Implement `src/suggest.ts`**

```ts
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	let curr = new Array<number>(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

/** Max edit distance allowed for a basename to count as a near-match. */
function threshold(base: string): number {
	return Math.max(2, Math.floor(base.length * 0.34));
}

export function nearMatches(value: string, cwd: string, max = 3): string[] {
	const resolved = resolve(cwd, value);
	const dir = dirname(resolved);
	if (!existsSync(dir)) return [];
	const target = basename(resolved).toLowerCase();
	const limit = threshold(target);

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const scored = entries
		.map((name) => ({ name, score: levenshtein(target, name.toLowerCase()) }))
		.filter((e) => e.score <= limit)
		.sort((a, b) => a.score - b.score)
		.slice(0, max);

	return scored.map((e) => relative(cwd, resolve(dir, e.name)).split("\\").join("/"));
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run test/suggest.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/suggest.ts agent/extensions/pi-toolcall-guard/test/suggest.test.ts
git commit -m "feat(guard): edit-distance near-match suggestions"
```

---

## Task 4: Preflight decision

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/preflight.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/preflight.test.ts`

**Interfaces:**
- Consumes: `getPathArg`, `normalizePathValue`, `pathExists`, `PATH_TOOLS` from `./paths`; `nearMatches` from `./suggest`.
- Produces:
  - `type PreflightOutcome = { kind: "pass" } | { kind: "normalized"; key: string; value: string } | { kind: "block"; reason: string }`
  - `function preflight(args: { toolName: string; input: Record<string, unknown>; cwd: string }): PreflightOutcome`

**Decision logic (in order):**
1. No path arg → `pass`.
2. Compute `normalized = normalizePathValue(value)` and `resolved = resolve(cwd, normalized)`.
3. **Write tool** (`isWrite`): the target may legitimately not exist; check the *parent* dir. Parent exists → if `normalized !== value` return `normalized`-repair, else `pass`. Parent missing → `block` ("parent directory … does not exist").
4. **Read-like tool**: target must exist. Exists → if `normalized !== value` return `normalized`-repair, else `pass`. Missing → `block` with `nearMatches` suggestions (or an ls/find pointer when none).

- [ ] **Step 1: Write the failing test** — `test/preflight.test.ts`

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../src/preflight";

describe("preflight", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "guard-preflight-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "utils.ts"), "");
	});
	afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

	it("passes an existing read path unchanged", () => {
		expect(preflight({ toolName: "read", input: { path: "src/utils.ts" }, cwd: dir }))
			.toEqual({ kind: "pass" });
	});

	it("passes unknown tools", () => {
		expect(preflight({ toolName: "expand", input: { path: "whatever" }, cwd: dir }))
			.toEqual({ kind: "pass" });
	});

	it("passes optional-path tools that omit the path", () => {
		expect(preflight({ toolName: "grep", input: { pattern: "x" }, cwd: dir }))
			.toEqual({ kind: "pass" });
	});

	it("normalizes a quoted path that exists, returning the repaired value", () => {
		const out = preflight({ toolName: "read", input: { path: '"src/utils.ts"' }, cwd: dir });
		expect(out).toEqual({ kind: "normalized", key: "path", value: "src/utils.ts" });
	});

	it("blocks a nonexistent read path and suggests the near match", () => {
		const out = preflight({ toolName: "read", input: { path: "src/util.ts" }, cwd: dir });
		expect(out.kind).toBe("block");
		if (out.kind === "block") {
			expect(out.reason).toContain("does not exist");
			expect(out.reason).toContain("src/utils.ts");
		}
	});

	it("blocks a nonexistent read path with an ls/find pointer when no near match", () => {
		const out = preflight({ toolName: "read", input: { path: "src/zzzzzzzz.ts" }, cwd: dir });
		expect(out.kind).toBe("block");
		if (out.kind === "block") expect(out.reason).toMatch(/ls|find/);
	});

	it("passes a write to a new file when the parent dir exists", () => {
		expect(preflight({ toolName: "write", input: { path: "src/new.ts", content: "x" }, cwd: dir }))
			.toEqual({ kind: "pass" });
	});

	it("blocks a write whose parent dir does not exist", () => {
		const out = preflight({ toolName: "write", input: { path: "nope/new.ts", content: "x" }, cwd: dir });
		expect(out.kind).toBe("block");
		if (out.kind === "block") expect(out.reason).toContain("parent directory");
	});
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run test/preflight.test.ts`
Expected: FAIL — cannot find `../src/preflight`.

- [ ] **Step 3: Implement `src/preflight.ts`**

```ts
import { dirname, resolve } from "node:path";
import { getPathArg, normalizePathValue, pathExists, PATH_TOOLS } from "./paths";
import { nearMatches } from "./suggest";

export type PreflightOutcome =
	| { kind: "pass" }
	| { kind: "normalized"; key: string; value: string }
	| { kind: "block"; reason: string };

export function preflight(args: {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
}): PreflightOutcome {
	const { toolName, input, cwd } = args;
	const arg = getPathArg(toolName, input);
	if (!arg) return { kind: "pass" };

	const normalized = normalizePathValue(arg.value);
	const resolved = resolve(cwd, normalized);
	const meta = PATH_TOOLS[toolName];

	if (meta.isWrite) {
		const parent = dirname(resolved);
		if (pathExists(parent)) {
			return normalized !== arg.value
				? { kind: "normalized", key: arg.key, value: normalized }
				: { kind: "pass" };
		}
		return {
			kind: "block",
			reason: `Cannot write "${arg.value}": its parent directory does not exist relative to ${cwd}. Create the directory first, or fix the path.`,
		};
	}

	if (pathExists(resolved)) {
		return normalized !== arg.value
			? { kind: "normalized", key: arg.key, value: normalized }
			: { kind: "pass" };
	}

	const suggestions = nearMatches(normalized, cwd);
	const tail = suggestions.length
		? ` Did you mean: ${suggestions.join(", ")}?`
		: ` Use ls or find to locate it before retrying.`;
	return {
		kind: "block",
		reason: `Path "${arg.value}" does not exist relative to ${cwd}.${tail}`,
	};
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run test/preflight.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/preflight.ts agent/extensions/pi-toolcall-guard/test/preflight.test.ts
git commit -m "feat(guard): preflight path-reality decision"
```

---

## Task 5: Error enrichment rules

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/enrich.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/enrich.test.ts`

**Interfaces:**
- Consumes: nothing (pure string→string).
- Produces:
  - `interface EnrichRule { id: string; test: RegExp; hint: string }`
  - `const RULES: EnrichRule[]` — ordered; first match wins. Stale-anchor must precede the generic not-found rule.
  - `function enrichError(toolName: string, text: string): { rule: string; text: string } | null` — returns the original text with `\n\n[guard] <hint>` appended on the first matching rule, else `null`.

- [ ] **Step 1: Write the failing test** — `test/enrich.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { enrichError, RULES } from "../src/enrich";

describe("enrichError", () => {
	it("returns null when no rule matches", () => {
		expect(enrichError("bash", "some unremarkable output")).toBeNull();
	});

	it("enriches ENOENT errors with an ls/find pointer", () => {
		const out = enrichError("read", "ENOENT: no such file or directory, open 'x'");
		expect(out).not.toBeNull();
		expect(out!.rule).toBe("enoent");
		expect(out!.text).toContain("ENOENT");
		expect(out!.text).toContain("[guard]");
	});

	it("enriches schema-validation errors with a parameter-name pointer", () => {
		const out = enrichError("read", "Invalid arguments: unknown property 'filepath'");
		expect(out!.rule).toBe("schema");
	});

	it("enriches stale-anchor errors before falling through to not-found", () => {
		const out = enrichError("edit", "Edit failed: stale anchor, hash mismatch on line 12");
		expect(out!.rule).toBe("stale-anchor");
		expect(out!.text.toLowerCase()).toContain("re-read");
	});

	it("enriches command-not-found", () => {
		const out = enrichError("bash", "bash: foo: command not found");
		expect(out!.rule).toBe("command-not-found");
	});

	it("enriches permission errors", () => {
		const out = enrichError("write", "EACCES: permission denied, open 'x'");
		expect(out!.rule).toBe("permission");
	});

	it("appends exactly one hint block", () => {
		const out = enrichError("read", "ENOENT: no such file");
		expect(out!.text.match(/\[guard\]/g)).toHaveLength(1);
	});

	it("RULES are uniquely identified", () => {
		const ids = RULES.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run test/enrich.test.ts`
Expected: FAIL — cannot find `../src/enrich`.

- [ ] **Step 3: Implement `src/enrich.ts`**

```ts
export interface EnrichRule {
	id: string;
	test: RegExp;
	hint: string;
}

/**
 * Ordered rule table; first match wins. Order matters: stale-anchor must be
 * tested before the generic not-found patterns because anchor errors often
 * contain the words "not found".
 */
export const RULES: EnrichRule[] = [
	{
		id: "stale-anchor",
		test: /stale|hash mismatch|anchor (?:.*)?(?:not found|changed|mismatch)/i,
		hint: "The file changed since you last read it. Re-read it to get fresh LINE#HASH anchors, then redo the edit against the current contents.",
	},
	{
		id: "schema",
		test: /invalid arguments|unknown (?:property|argument|key)|unexpected property|required property|expected .+ (?:but|, )/i,
		hint: "The arguments don't match this tool's schema. Check the exact parameter names and types for this tool, then resend the call.",
	},
	{
		id: "enoent",
		test: /ENOENT|no such file or directory|cannot find the (?:path|file)/i,
		hint: "The path doesn't exist. List the directory (ls) or search (find) to confirm the exact path before retrying.",
	},
	{
		id: "command-not-found",
		test: /command not found|is not recognized as|: not found/i,
		hint: "That command isn't available on this system (Windows). Use an installed equivalent, or verify it's on PATH.",
	},
	{
		id: "permission",
		test: /EACCES|EPERM|permission denied|operation not permitted/i,
		hint: "Permission denied. The path may be read-only or held open by another process.",
	},
];

export function enrichError(
	_toolName: string,
	text: string,
): { rule: string; text: string } | null {
	for (const rule of RULES) {
		if (rule.test.test(text)) {
			return { rule: rule.id, text: `${text}\n\n[guard] ${rule.hint}` };
		}
	}
	return null;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run test/enrich.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/enrich.ts agent/extensions/pi-toolcall-guard/test/enrich.test.ts
git commit -m "feat(guard): error-enrichment rule table"
```

---

## Task 6: Extension entrypoint wiring

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/index.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/integration.test.ts`

**Interfaces:**
- Consumes: `preflight` from `./src/preflight`; `enrichError` from `./src/enrich`; `Metrics` from `./src/metrics`.
- Produces: `export default function (pi: ExtensionAPI): void`.

**Behavior:**
- Resolve dir from `PI_GUARD_DIR` else `~/.pi/guard`; `mkdirSync(recursive)`; on failure return (degrade — no hooks, no throw).
- `pendingBlock: Set<string>` tracks tools whose last call this turn was blocked (the recovery denominator).
- `tool_call` handler (wrapped in try/catch returning `undefined` on any internal error):
  - `out = preflight({ toolName, input: event.input, cwd: ctx.cwd })`.
  - `normalized` → mutate `event.input[out.key] = out.value`; record `{preflight, normalized}`; return `undefined` (proceed).
  - `block` → `pendingBlock.add(toolName)`; record `{preflight, block}`; return `{ block: true, reason: out.reason }`.
  - `pass` → return `undefined`.
- `tool_result` handler:
  - If `!event.isError`: if `pendingBlock.has(toolName)` → delete + record `{preflight_recovered}`. Return `undefined`.
  - If `isError`: require single text content; `enrichError(toolName, text)`; record `{enrich, matched}`; if matched return `{ content: [text] }`, else `undefined`.

- [ ] **Step 1: Write the failing test** — `test/integration.test.ts`

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index";

function makePi() {
	const handlers: Record<string, (e: any, ctx: any) => any> = {};
	const pi = {
		registerTool: () => {},
		on: (ev: string, h: (e: any, ctx: any) => any) => { handlers[ev] = h; },
	} as any;
	return { pi, handlers };
}

describe("guard integration", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "guard-int-"));
		process.env.PI_GUARD_DIR = join(dir, "metrics");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "utils.ts"), "");
	});
	afterEach(() => { delete process.env.PI_GUARD_DIR; try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

	it("blocks a nonexistent read path with a suggestion", () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c1", input: { path: "src/util.ts" } },
			{ cwd: dir },
		);
		expect(res.block).toBe(true);
		expect(res.reason).toContain("src/utils.ts");
	});

	it("repairs a quoted path in place and proceeds", () => {
		const { pi, handlers } = makePi();
		register(pi);
		const input = { path: '"src/utils.ts"' };
		const res = handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c2", input },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
		expect(input.path).toBe("src/utils.ts"); // mutated in place
	});

	it("passes an existing path untouched", () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c3", input: { path: "src/utils.ts" } },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
	});

	it("enriches an error result and leaves success results alone", () => {
		const { pi, handlers } = makePi();
		register(pi);
		const err = handlers.tool_result({
			type: "tool_result", toolName: "read", toolCallId: "c4", input: {},
			isError: true, content: [{ type: "text", text: "ENOENT: no such file" }], details: undefined,
		});
		expect(err.content[0].text).toContain("[guard]");

		const ok = handlers.tool_result({
			type: "tool_result", toolName: "bash", toolCallId: "c5", input: {},
			isError: false, content: [{ type: "text", text: "fine" }], details: undefined,
		});
		expect(ok).toBeUndefined();
	});

	it("records a recovery when a blocked tool later succeeds", () => {
		const { pi, handlers } = makePi();
		register(pi);
		handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c6", input: { path: "src/missing.ts" } },
			{ cwd: dir },
		);
		handlers.tool_result({
			type: "tool_result", toolName: "read", toolCallId: "c7", input: {},
			isError: false, content: [{ type: "text", text: "ok" }], details: undefined,
		});
		const log = readFileSync(join(dir, "metrics", ".pi-guard-metrics.jsonl"), "utf8");
		expect(log).toContain('"preflight_recovered"');
	});

	it("degrades to a no-op (no hooks) when the metrics dir cannot be created", () => {
		const filePath = join(dir, "iamafile");
		writeFileSync(filePath, "x");
		process.env.PI_GUARD_DIR = join(filePath, "sub");
		const { pi, handlers } = makePi();
		expect(() => register(pi)).not.toThrow();
		expect(handlers.tool_call).toBeUndefined();
		expect(handlers.tool_result).toBeUndefined();
	});

	it("never throws out of tool_call even on a malformed event", () => {
		const { pi, handlers } = makePi();
		register(pi);
		expect(() => handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c8", input: null as any },
			{ cwd: dir },
		)).not.toThrow();
	});
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — cannot find `../index`.

- [ ] **Step 3: Implement `index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Metrics } from "./src/metrics";
import { preflight } from "./src/preflight";
import { enrichError } from "./src/enrich";

export default function (pi: ExtensionAPI): void {
	const dir = process.env.PI_GUARD_DIR ?? join(homedir(), ".pi", "guard");
	let metrics: Metrics;
	try {
		mkdirSync(dir, { recursive: true });
		metrics = new Metrics(join(dir, ".pi-guard-metrics.jsonl"));
	} catch {
		// Cannot create the metrics dir — degrade to a no-op rather than throwing
		// out of the extension entrypoint and disrupting the host session.
		return;
	}

	// Tools whose most recent call this session was blocked by preflight. A later
	// successful (non-error) result for the same tool is counted as a recovery —
	// the rough signal that the block's guidance worked. Heuristic, not exact.
	const pendingBlock = new Set<string>();

	pi.on("tool_call", (event, ctx) => {
		try {
			const input = (event.input ?? {}) as Record<string, unknown>;
			const out = preflight({ toolName: event.toolName, input, cwd: ctx.cwd });
			if (out.kind === "normalized") {
				input[out.key] = out.value;
				metrics.record({ kind: "preflight", outcome: "normalized", toolName: event.toolName });
				return;
			}
			if (out.kind === "block") {
				pendingBlock.add(event.toolName);
				metrics.record({ kind: "preflight", outcome: "block", toolName: event.toolName });
				return { block: true, reason: out.reason };
			}
			return;
		} catch {
			// Never throw into beforeToolCall — a throw blocks the tool (agent-loop).
			return;
		}
	});

	pi.on("tool_result", (event) => {
		if (!event.isError) {
			if (pendingBlock.has(event.toolName)) {
				pendingBlock.delete(event.toolName);
				metrics.record({ kind: "preflight_recovered", toolName: event.toolName });
			}
			return;
		}
		if (event.content.length !== 1 || event.content[0]?.type !== "text") return;
		const text = (event.content[0] as { type: "text"; text: string }).text;
		const enriched = enrichError(event.toolName, text);
		metrics.record({ kind: "enrich", matched: !!enriched, rule: enriched?.rule, toolName: event.toolName });
		if (!enriched) return;
		return { content: [{ type: "text" as const, text: enriched.text }] };
	});
}
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS (all tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/index.ts agent/extensions/pi-toolcall-guard/test/integration.test.ts
git commit -m "feat(guard): wire preflight + enrich hooks with recovery metric"
```

---

## Task 7: Effectiveness report

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/scripts/report.mjs`
- Test: `agent/extensions/pi-toolcall-guard/test/report.test.mjs`

**Interfaces:**
- Consumes: the JSONL metrics file.
- Produces (all exported for testing):
  - `function parseEvents(text: string): object[]` — JSONL parse, skipping blank/malformed lines.
  - `function aggregate(events): { rows, totals }` — per-tool `{ tool, blocks, normalized, recovered, recoveryRate, enrichMatched, enrichTotal }`, plus a `totals` row. `recoveryRate = recovered / blocks` (0 when blocks is 0).
  - `function formatReport({ rows, totals }): string` — a fixed-width table.
  - When run as a script: read `PI_GUARD_DIR` (or `~/.pi/guard`) `/.pi-guard-metrics.jsonl`, print the report.

- [ ] **Step 1: Write the failing test** — `test/report.test.mjs`

```js
import { describe, expect, it } from "vitest";
import { parseEvents, aggregate } from "../scripts/report.mjs";

describe("report aggregate", () => {
	it("parses JSONL and skips blank/malformed lines", () => {
		const text = [
			'{"kind":"preflight","outcome":"block","toolName":"read"}',
			"",
			"not json",
			'{"kind":"preflight_recovered","toolName":"read"}',
		].join("\n");
		expect(parseEvents(text)).toHaveLength(2);
	});

	it("computes blocks, recoveries, recovery rate, and enrich counts per tool", () => {
		const events = [
			{ kind: "preflight", outcome: "block", toolName: "read" },
			{ kind: "preflight", outcome: "block", toolName: "read" },
			{ kind: "preflight", outcome: "normalized", toolName: "read" },
			{ kind: "preflight_recovered", toolName: "read" },
			{ kind: "enrich", matched: true, rule: "enoent", toolName: "bash" },
			{ kind: "enrich", matched: false, toolName: "bash" },
		];
		const { rows, totals } = aggregate(events);
		const read = rows.find((r) => r.tool === "read");
		expect(read.blocks).toBe(2);
		expect(read.normalized).toBe(1);
		expect(read.recovered).toBe(1);
		expect(read.recoveryRate).toBeCloseTo(0.5);
		const bash = rows.find((r) => r.tool === "bash");
		expect(bash.enrichMatched).toBe(1);
		expect(bash.enrichTotal).toBe(2);
		expect(totals.blocks).toBe(2);
		expect(totals.recovered).toBe(1);
	});
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run test/report.test.mjs`
Expected: FAIL — cannot find `../scripts/report.mjs`.

- [ ] **Step 3: Implement `scripts/report.mjs`**

```js
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function parseEvents(text) {
	const out = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
	}
	return out;
}

export function aggregate(events) {
	const byTool = new Map();
	const get = (tool) => {
		let r = byTool.get(tool);
		if (!r) {
			r = { tool, blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0 };
			byTool.set(tool, r);
		}
		return r;
	};
	for (const e of events) {
		const r = get(e.toolName);
		if (e.kind === "preflight" && e.outcome === "block") r.blocks++;
		else if (e.kind === "preflight" && e.outcome === "normalized") r.normalized++;
		else if (e.kind === "preflight_recovered") r.recovered++;
		else if (e.kind === "enrich") { r.enrichTotal++; if (e.matched) r.enrichMatched++; }
	}
	const rows = [...byTool.values()].map((r) => ({
		...r,
		recoveryRate: r.blocks ? r.recovered / r.blocks : 0,
	}));
	rows.sort((a, b) => (b.blocks + b.enrichTotal) - (a.blocks + a.enrichTotal));
	const totals = rows.reduce(
		(t, r) => ({
			tool: "TOTAL",
			blocks: t.blocks + r.blocks,
			normalized: t.normalized + r.normalized,
			recovered: t.recovered + r.recovered,
			recoveryRate: 0,
			enrichMatched: t.enrichMatched + r.enrichMatched,
			enrichTotal: t.enrichTotal + r.enrichTotal,
		}),
		{ tool: "TOTAL", blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0 },
	);
	totals.recoveryRate = totals.blocks ? totals.recovered / totals.blocks : 0;
	return { rows, totals };
}

export function formatReport({ rows, totals }) {
	const header = ["tool", "blocks", "norm", "recov", "recov%", "enrich"].join("\t");
	const fmt = (r) => [r.tool, r.blocks, r.normalized, r.recovered, `${(r.recoveryRate * 100).toFixed(0)}%`, `${r.enrichMatched}/${r.enrichTotal}`].join("\t");
	return [header, ...rows.map(fmt), "—", fmt(totals)].join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("report.mjs");
if (isMain) {
	const dir = process.env.PI_GUARD_DIR ?? join(homedir(), ".pi", "guard");
	const path = join(dir, ".pi-guard-metrics.jsonl");
	let text = "";
	try { text = readFileSync(path, "utf8"); } catch { console.log(`No metrics at ${path}`); process.exit(0); }
	console.log(formatReport(aggregate(parseEvents(text))));
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run test/report.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite once more**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/scripts/report.mjs agent/extensions/pi-toolcall-guard/test/report.test.mjs
git commit -m "feat(guard): effectiveness report with recovery rate"
```

---

## Task 8: Acceptance documentation

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/docs/acceptance.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Write `docs/acceptance.md`**

Document the live acceptance cases an operator runs against a real pi session. Include exactly these cases, each with the action and the expected guard behavior:

1. **Near-miss read** — ask the agent to read a path one character off from a real file (e.g. `src/util.ts` when `src/utils.ts` exists). Expect: blocked with `Did you mean: src/utils.ts?`, and the agent re-issues the correct path.
2. **Quoted path** — induce a read with surrounding quotes. Expect: silently normalized in place, tool proceeds, no block.
3. **Existing path** — normal read of a real file. Expect: pass-through, no guard text.
4. **Write to new file in existing dir** — expect: pass (writes are allowed to create files).
5. **Write into a missing directory** — expect: blocked with a "parent directory does not exist" reason.
6. **ENOENT enrichment** — force a tool error containing `ENOENT`. Expect: result text gains a single `[guard]` ls/find hint.
7. **Stale-anchor enrichment** — trigger a hashline stale-anchor edit error. Expect: `[guard]` "re-read … fresh LINE#HASH anchors" hint, and the stale-anchor rule wins over not-found.
8. **Recovery metric** — after a block (case 1), confirm `npm run report` shows a non-zero `recov%` for that tool once the agent succeeds.
9. **Degrade** — set `PI_GUARD_DIR` to an uncreatable path; confirm pi still starts and tools run unguarded.

State the report command verbatim: `cd agent/extensions/pi-toolcall-guard && npm run report` (set `PI_GUARD_DIR` to match the session if overridden).

- [ ] **Step 2: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/docs/acceptance.md
git commit -m "docs(guard): live acceptance cases"
```

---

## Notes for the executor

- The host pipeline is confirmed: `tool_call` fires *after* schema validation (`pi-agent-core/dist/agent-loop.js:361-377`), so a returned `{ block, reason }` becomes an error tool result via `createErrorToolResult`, and `event.input` mutations are applied with no re-validation. Schema-invalid calls never reach `tool_call` — they surface at `tool_result` with `isError: true`, which is why the enricher's `schema` rule matters.
- `read`/`edit` are overridden by the `pi-hashline-edit` extension in this harness. The guard only ever inspects/normalizes the *path* arg and never touches edit anchors or content, so it composes safely. `getPathArg` checks both `path` and `file_path` to stay robust to hashline's parameter naming.
- The enricher and `pi-context-collapse` both subscribe to `tool_result` but never overlap: collapse skips `isError` results, the enricher acts only on `isError` results.
- Keep all new files LF. After implementation, verify no CRLF crept in (the repo `.editorconfig` mandates LF).

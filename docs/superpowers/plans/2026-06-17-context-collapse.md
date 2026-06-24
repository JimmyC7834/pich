# Context-Collapse Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi extension that deterministically collapses bulky tool outputs to a compact form once, on write, while caching the raw original so the agent can `expand` it on demand.

**Architecture:** Hook `pi.on("tool_result")` (fires once after a tool runs, can replace the result). For each result: classify content type, run a pure-function compressor, save the raw to a SQLite originals-cache keyed by content hash, and replace the in-context text with `⟦type:hash⟧ + summary`. A registered `expand` tool returns the raw (sliced) for a given handle. No model, no network in the collapse path.

**Tech Stack:** TypeScript (Node ESM), pi-coding-agent extension API, `better-sqlite3` (originals cache + already in the tree), `@sinclair/typebox` (tool schema), Vitest.

## Global Constraints

- **Deterministic only.** No LLM, no network, no async model calls in the classify/compress path. Pure functions.
- **Never collapse `read` or `edit` results.** Hashline anchors are byte-exact; routing must exempt these tool names. (Verbatim exempt set: `read`, `edit`.)
- **Never collapse error results.** If `event.isError` is true, pass through unchanged.
- **Reversible.** Every collapse saves the raw original to the cache before replacing content. The in-context copy is frozen (write-once) — `expand` produces a *new* result, never mutates the old one (preserves KV-cache stability).
- **Only collapse when it helps.** If a compressor's output is not smaller than the input, skip (pass through).
- **Single text block only.** If `event.content` is not exactly one `{type:"text"}` block (e.g. images, multimodal), pass through.
- **Size floor:** `MIN_COLLAPSE_TOKENS = 200`. Below this, pass through.
- **Module system:** ESM (`"type": "module"`). Handle marker uses Unicode `⟦` (U+27E6) / `⟧` (U+27E7), written as `⟦` / `⟧` in source.
- **Extension location:** `agent/extensions/pi-context-collapse/`.

---

## File Structure

```
agent/extensions/pi-context-collapse/
├─ package.json              private ESM manifest, pi.extensions=["./index.ts"]
├─ tsconfig.json             ESNext / bundler / strict
├─ index.ts                  wires tool_result handler + expand tool + cache + metrics
├─ src/
│   ├─ tokens.ts             estimateTokens(text) → number
│   ├─ handle.ts             hashContent, makeHandle, parseHandle
│   ├─ cache.ts              OriginalsCache (sqlite save/get)
│   ├─ router.ts             classify(toolName, text) → ContentType | null
│   ├─ collapse.ts           collapseText(...) orchestrator
│   ├─ metrics.ts            Metrics.record(event) → jsonl
│   ├─ expand.ts             registerExpandTool(pi, cache, metrics)
│   └─ compressors/
│        ├─ json.ts          compressJson(text)
│        ├─ log.ts           compressLog(text)
│        └─ paths.ts         compressPaths(text)
└─ test/
    ├─ tokens.test.ts
    ├─ handle.test.ts
    ├─ cache.test.ts
    ├─ router.test.ts
    ├─ compressors/json.test.ts
    ├─ compressors/log.test.ts
    ├─ compressors/paths.test.ts
    ├─ collapse.test.ts
    ├─ metrics.test.ts
    ├─ expand.test.ts
    ├─ index.test.ts
    └─ integration.test.ts
```

**Shared types / signatures (used across tasks):**
- `estimateTokens(text: string): number`
- `hashContent(text: string): string` (12 lowercase hex chars)
- `makeHandle(type: string, hash: string): string` → `"⟦type:hash⟧"`
- `parseHandle(text: string): { type: string; hash: string } | null`
- `type ContentType = "json" | "log" | "paths"`
- `classify(toolName: string, text: string): ContentType | null`
- `compressJson(text: string): string`, `compressLog(text: string): string`, `compressPaths(text: string): string`
- `interface OriginalRecord { raw: string; toolName: string; type: ContentType; createdAt: number }`
- `class OriginalsCache { constructor(path?: string); save(hash, rec): void; get(hash): OriginalRecord | undefined; close(): void }`
- `interface CollapseResult { collapsed: string; handle: string; type: ContentType }`
- `collapseText(params: { toolName: string; text: string; cache: OriginalsCache; now?: () => number }): CollapseResult | null`
- `class Metrics { constructor(path: string); record(event: MetricEvent): void }`
- `registerExpandTool(pi: ExtensionAPI, cache: OriginalsCache, metrics: Metrics): void`

---

### Task 1: Scaffold + token estimator

**Files:**
- Create: `agent/extensions/pi-context-collapse/package.json`
- Create: `agent/extensions/pi-context-collapse/tsconfig.json`
- Create: `agent/extensions/pi-context-collapse/src/tokens.ts`
- Test: `agent/extensions/pi-context-collapse/test/tokens.test.ts`

**Interfaces:**
- Produces: `estimateTokens(text: string): number`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pi-context-collapse",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "description": "Deterministic write-once collapse of bulky tool outputs, with reversible originals cache",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.8.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.2",
    "@sinclair/typebox": "^0.34.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

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

- [ ] **Step 3: Install dependencies**

Run: `cd agent/extensions/pi-context-collapse && npm install --no-audit --no-fund`
Expected: completes; `node_modules/better-sqlite3` present.

- [ ] **Step 4: Write the failing test** — `test/tokens.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/tokens";

describe("estimateTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});
	it("estimates ~1 token per 4 chars, rounding up", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run test/tokens.test.ts`
Expected: FAIL — cannot find module `../src/tokens`.

- [ ] **Step 6: Write minimal implementation** — `src/tokens.ts`

```ts
/** Cheap deterministic token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/tokens.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add agent/extensions/pi-context-collapse
git commit -m "feat(collapse): scaffold extension + token estimator"
```

---

### Task 2: Handle (hash, make, parse)

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/handle.ts`
- Test: `agent/extensions/pi-context-collapse/test/handle.test.ts`

**Interfaces:**
- Produces: `hashContent(text): string`, `makeHandle(type, hash): string`, `parseHandle(text): { type; hash } | null`

- [ ] **Step 1: Write the failing test** — `test/handle.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { hashContent, makeHandle, parseHandle } from "../src/handle";

describe("handle", () => {
	it("hashContent is deterministic, 12 lowercase hex chars", () => {
		const h = hashContent("hello");
		expect(h).toMatch(/^[0-9a-f]{12}$/);
		expect(hashContent("hello")).toBe(h);
		expect(hashContent("world")).not.toBe(h);
	});
	it("makeHandle wraps type:hash in U+27E6/27E7", () => {
		expect(makeHandle("json", "abc123abc123")).toBe("⟦json:abc123abc123⟧");
	});
	it("parseHandle round-trips a handle embedded in surrounding text", () => {
		const handle = makeHandle("log", "deadbeef0000");
		expect(parseHandle(`prefix ${handle} suffix`)).toEqual({ type: "log", hash: "deadbeef0000" });
	});
	it("parseHandle returns null when no handle present", () => {
		expect(parseHandle("just text")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/handle.test.ts`
Expected: FAIL — cannot find module `../src/handle`.

- [ ] **Step 3: Write minimal implementation** — `src/handle.ts`

```ts
import { createHash } from "node:crypto";

/** Content-addressed 12-hex-char key for an original tool result. */
export function hashContent(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Build the in-context marker, e.g. "⟦json:abc123⟧". */
export function makeHandle(type: string, hash: string): string {
	return `⟦${type}:${hash}⟧`;
}

const HANDLE_RE = /⟦([a-z]+):([0-9a-f]{6,64})⟧/;

/** Extract { type, hash } from text containing a handle, else null. */
export function parseHandle(text: string): { type: string; hash: string } | null {
	const m = text.match(HANDLE_RE);
	return m ? { type: m[1]!, hash: m[2]! } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/handle.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/handle.ts agent/extensions/pi-context-collapse/test/handle.test.ts
git commit -m "feat(collapse): content hashing and handle markers"
```

---

### Task 3: Originals cache (SQLite)

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/cache.ts`
- Test: `agent/extensions/pi-context-collapse/test/cache.test.ts`

**Interfaces:**
- Produces: `interface OriginalRecord { raw: string; toolName: string; type: ContentType; createdAt: number }`, `class OriginalsCache`
- Note: `ContentType` is defined in Task 4 (`router.ts`). For this task, import the type from `./router` — it is a type-only import and Task 4 lands before integration. If implementing strictly in order, temporarily declare `type ContentType = "json" | "log" | "paths"` inline and replace with the import in Task 4. Prefer the inline declaration to keep the task self-contained.

- [ ] **Step 1: Write the failing test** — `test/cache.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { OriginalsCache } from "../src/cache";

describe("OriginalsCache", () => {
	it("saves and retrieves a record by hash (in-memory)", () => {
		const cache = new OriginalsCache(":memory:");
		cache.save("h1", { raw: "RAW", toolName: "bash", type: "log", createdAt: 100 });
		expect(cache.get("h1")).toEqual({ raw: "RAW", toolName: "bash", type: "log", createdAt: 100 });
		cache.close();
	});
	it("returns undefined for a missing hash", () => {
		const cache = new OriginalsCache(":memory:");
		expect(cache.get("nope")).toBeUndefined();
		cache.close();
	});
	it("overwrites on duplicate hash", () => {
		const cache = new OriginalsCache(":memory:");
		cache.save("h1", { raw: "A", toolName: "bash", type: "json", createdAt: 1 });
		cache.save("h1", { raw: "B", toolName: "bash", type: "json", createdAt: 2 });
		expect(cache.get("h1")?.raw).toBe("B");
		cache.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cache.test.ts`
Expected: FAIL — cannot find module `../src/cache`.

- [ ] **Step 3: Write minimal implementation** — `src/cache.ts`

```ts
import Database from "better-sqlite3";

export type ContentType = "json" | "log" | "paths";

export interface OriginalRecord {
	raw: string;
	toolName: string;
	type: ContentType;
	createdAt: number;
}

export class OriginalsCache {
	private db: Database.Database;

	constructor(path = ":memory:") {
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`CREATE TABLE IF NOT EXISTS originals (
			hash TEXT PRIMARY KEY,
			raw TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			type TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`);
	}

	save(hash: string, rec: OriginalRecord): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO originals (hash, raw, tool_name, type, created_at) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(hash, rec.raw, rec.toolName, rec.type, rec.createdAt);
	}

	get(hash: string): OriginalRecord | undefined {
		const row = this.db
			.prepare(`SELECT raw, tool_name, type, created_at FROM originals WHERE hash = ?`)
			.get(hash) as
			| { raw: string; tool_name: string; type: ContentType; created_at: number }
			| undefined;
		if (!row) return undefined;
		return { raw: row.raw, toolName: row.tool_name, type: row.type, createdAt: row.created_at };
	}

	close(): void {
		this.db.close();
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cache.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/cache.ts agent/extensions/pi-context-collapse/test/cache.test.ts
git commit -m "feat(collapse): sqlite originals cache"
```

---

### Task 4: Router / classifier

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/router.ts`
- Test: `agent/extensions/pi-context-collapse/test/router.test.ts`

**Interfaces:**
- Consumes: `estimateTokens` (Task 1)
- Produces: `type ContentType = "json" | "log" | "paths"`, `classify(toolName, text): ContentType | null`, `MIN_COLLAPSE_TOKENS`
- Note: re-export `ContentType` from here; `cache.ts` may switch to `import type { ContentType } from "./router"` once this lands.

- [ ] **Step 1: Write the failing test** — `test/router.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { classify } from "../src/router";

const big = (line: string, n: number) => Array.from({ length: n }, () => line).join("\n");

describe("classify", () => {
	it("exempts read and edit regardless of content", () => {
		const json = JSON.stringify({ a: 1, b: "x".repeat(2000) });
		expect(classify("read", json)).toBeNull();
		expect(classify("edit", json)).toBeNull();
	});
	it("passes through small content", () => {
		expect(classify("bash", "small output")).toBeNull();
	});
	it("classifies large JSON as json", () => {
		const json = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ i })) });
		expect(classify("bash", json)).toBe("json");
	});
	it("classifies repetitive log output as log", () => {
		// line is long enough that 30 copies clear the 200-token floor
		const text = big("INFO 2026-06-17T00:00:00 worker tick processing queued item", 30);
		expect(classify("bash", text)).toBe("log");
	});
	it("classifies a large bare-path list as paths", () => {
		const text = Array.from({ length: 50 }, (_, i) => `src/dir/file${i}.ts`).join("\n");
		expect(classify("bash", text)).toBe("paths");
	});
	it("does NOT classify code (non-json, low-dup, not path list)", () => {
		const code = Array.from({ length: 60 }, (_, i) => `  const v${i} = compute(${i}) + offset;`).join("\n");
		expect(classify("bash", code)).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/router.test.ts`
Expected: FAIL — cannot find module `../src/router`.

- [ ] **Step 3: Write minimal implementation** — `src/router.ts`

```ts
import { estimateTokens } from "./tokens";

export type ContentType = "json" | "log" | "paths";

export const MIN_COLLAPSE_TOKENS = 200;

const EXEMPT_TOOLS = new Set(["read", "edit"]);

/** A line that is just a file path (no whitespace-separated content, no "file:line:" form). */
const BARE_PATH_RE = /^[\w.@~/\\-]+$/;

function isJsonObjectOrArray(text: string): boolean {
	const trimmed = text.trim();
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
	try {
		const v: unknown = JSON.parse(trimmed);
		return typeof v === "object" && v !== null;
	} catch {
		return false;
	}
}

function nonEmptyLines(text: string): string[] {
	return text.split("\n").filter((l) => l.trim().length > 0);
}

function ratio(lines: string[], pred: (l: string) => boolean): number {
	if (lines.length === 0) return 0;
	return lines.filter(pred).length / lines.length;
}

function duplicateRatio(lines: string[]): number {
	if (lines.length === 0) return 0;
	const unique = new Set(lines).size;
	return 1 - unique / lines.length;
}

/** Pick a content type to collapse, or null to pass through. Conservative: unsure → null. */
export function classify(toolName: string, text: string): ContentType | null {
	if (EXEMPT_TOOLS.has(toolName)) return null;
	if (estimateTokens(text) < MIN_COLLAPSE_TOKENS) return null;

	if (isJsonObjectOrArray(text)) return "json";

	const lines = nonEmptyLines(text);
	if (lines.length >= 40 && ratio(lines, (l) => BARE_PATH_RE.test(l.trim())) >= 0.8) {
		return "paths";
	}
	if (lines.length >= 20 && duplicateRatio(lines) >= 0.3) {
		return "log";
	}
	return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/router.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/router.ts agent/extensions/pi-context-collapse/test/router.test.ts
git commit -m "feat(collapse): content-type router with exempt list and thresholds"
```

---

### Task 5: JSON compressor

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/compressors/json.ts`
- Test: `agent/extensions/pi-context-collapse/test/compressors/json.test.ts`

**Interfaces:**
- Produces: `compressJson(text: string): string`

- [ ] **Step 1: Write the failing test** — `test/compressors/json.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { compressJson } from "../../src/compressors/json";

describe("compressJson", () => {
	it("summarizes an array of objects with count, shape, and a sample", () => {
		const arr = Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, stars: i }));
		const out = compressJson(JSON.stringify(arr));
		expect(out).toContain("array[200]");
		expect(out).toContain("name");
		expect(out).toContain("sample[0]=");
	});
	it("summarizes an object listing keys and array-valued key counts", () => {
		const obj = { user: { id: 1 }, repos: Array.from({ length: 50 }, (_, i) => ({ i })) };
		const out = compressJson(JSON.stringify(obj));
		expect(out).toContain("object{");
		expect(out).toContain("repos: array[50]");
	});
	it("is shorter than the input on bulky data", () => {
		const arr = Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, stars: i }));
		const input = JSON.stringify(arr);
		expect(compressJson(input).length).toBeLessThan(input.length);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compressors/json.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation** — `src/compressors/json.ts`

```ts
function shape(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return `array[${v.length}]`;
	if (typeof v === "object") return `object{${Object.keys(v as object).join(",")}}`;
	return typeof v;
}

/** Deterministic structural summary of bulky JSON: shape + counts + one sample row. */
export function compressJson(text: string): string {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return text;
	}
	const lines: string[] = [];
	if (Array.isArray(data)) {
		lines.push(`array[${data.length}] of ${shape(data[0])}`);
		if (data.length > 0) lines.push(`sample[0]=${JSON.stringify(data[0])}`);
	} else if (data && typeof data === "object") {
		lines.push(`object{${Object.keys(data).join(", ")}}`);
		for (const [k, val] of Object.entries(data)) {
			if (Array.isArray(val)) lines.push(`  ${k}: array[${val.length}] of ${shape(val[0])}`);
		}
	} else {
		lines.push(JSON.stringify(data));
	}
	return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/compressors/json.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/compressors/json.ts agent/extensions/pi-context-collapse/test/compressors/json.test.ts
git commit -m "feat(collapse): json structural compressor"
```

---

### Task 6: Log compressor

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/compressors/log.ts`
- Test: `agent/extensions/pi-context-collapse/test/compressors/log.test.ts`

**Interfaces:**
- Produces: `compressLog(text: string): string`

- [ ] **Step 1: Write the failing test** — `test/compressors/log.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { compressLog } from "../../src/compressors/log";

describe("compressLog", () => {
	it("dedupes identical lines with a count, keeping first-seen order", () => {
		const text = ["INFO start", "INFO tick", "INFO tick", "INFO tick", "INFO end"].join("\n");
		const out = compressLog(text);
		expect(out).toBe(["INFO start", "INFO tick  (×3)", "INFO end"].join("\n"));
	});
	it("preserves unique lines (e.g. errors) verbatim", () => {
		const text = ["INFO a", "INFO a", "ERROR boom at x.ts:42"].join("\n");
		expect(compressLog(text)).toContain("ERROR boom at x.ts:42");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compressors/log.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation** — `src/compressors/log.ts`

```ts
/** Deterministic log dedupe: each unique line once (first-seen order) with a (×N) count. */
export function compressLog(text: string): string {
	const lines = text.split("\n");
	const order: string[] = [];
	const counts = new Map<string, number>();
	for (const line of lines) {
		if (!counts.has(line)) order.push(line);
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	return order
		.map((line) => {
			const n = counts.get(line)!;
			return n > 1 ? `${line}  (×${n})` : line;
		})
		.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/compressors/log.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/compressors/log.ts agent/extensions/pi-context-collapse/test/compressors/log.test.ts
git commit -m "feat(collapse): log dedupe compressor"
```

---

### Task 7: Paths compressor

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/compressors/paths.ts`
- Test: `agent/extensions/pi-context-collapse/test/compressors/paths.test.ts`

**Interfaces:**
- Produces: `compressPaths(text: string): string`

- [ ] **Step 1: Write the failing test** — `test/compressors/paths.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { compressPaths } from "../../src/compressors/paths";

describe("compressPaths", () => {
	it("reports total count and clusters by top-level directory", () => {
		const paths = [
			...Array.from({ length: 30 }, (_, i) => `src/core/f${i}.ts`),
			...Array.from({ length: 10 }, (_, i) => `test/unit/t${i}.ts`),
		].join("\n");
		const out = compressPaths(paths);
		expect(out).toContain("40 paths");
		expect(out).toContain("src/core (30)");
		expect(out).toContain("test/unit (10)");
	});
	it("is shorter than input on large lists", () => {
		const paths = Array.from({ length: 100 }, (_, i) => `src/a/b/file${i}.ts`).join("\n");
		expect(compressPaths(paths).length).toBeLessThan(paths.length);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compressors/paths.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation** — `src/compressors/paths.ts`

```ts
const MAX_DIRS = 8;

/** Deterministic path-list summary: total count + top directories by frequency. */
export function compressPaths(text: string): string {
	const paths = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const dirs = new Map<string, number>();
	for (const p of paths) {
		const parts = p.split(/[/\\]/);
		const top = parts.length >= 2 ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
		dirs.set(top, (dirs.get(top) ?? 0) + 1);
	}
	const top = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DIRS);
	const out = [`${paths.length} paths in ${dirs.size} dirs:`];
	for (const [d, n] of top) out.push(`  ${d} (${n})`);
	return out.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/compressors/paths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/compressors/paths.ts agent/extensions/pi-context-collapse/test/compressors/paths.test.ts
git commit -m "feat(collapse): path-list compressor"
```

---

### Task 8: Collapse orchestrator

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/collapse.ts`
- Test: `agent/extensions/pi-context-collapse/test/collapse.test.ts`

**Interfaces:**
- Consumes: `classify` (Task 4), `compressJson`/`compressLog`/`compressPaths` (5–7), `hashContent`/`makeHandle` (Task 2), `OriginalsCache` (Task 3)
- Produces: `interface CollapseResult { collapsed: string; handle: string; type: ContentType }`, `collapseText(params): CollapseResult | null`

- [ ] **Step 1: Write the failing test** — `test/collapse.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { collapseText } from "../src/collapse";
import { OriginalsCache } from "../src/cache";
import { parseHandle } from "../src/handle";

describe("collapseText", () => {
	it("returns null for exempt tools (read/edit)", () => {
		const cache = new OriginalsCache(":memory:");
		const json = JSON.stringify({ a: Array.from({ length: 100 }, (_, i) => i) });
		expect(collapseText({ toolName: "read", text: json, cache })).toBeNull();
		cache.close();
	});
	it("collapses big JSON, embeds a handle, and caches the raw", () => {
		const cache = new OriginalsCache(":memory:");
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, n: i })));
		const result = collapseText({ toolName: "bash", text: raw, cache, now: () => 123 });
		expect(result).not.toBeNull();
		const parsed = parseHandle(result!.collapsed);
		expect(parsed?.type).toBe("json");
		expect(cache.get(parsed!.hash)?.raw).toBe(raw);
		expect(cache.get(parsed!.hash)?.createdAt).toBe(123);
		cache.close();
	});
	it("returns null for content that does not classify (passes through)", () => {
		const cache = new OriginalsCache(":memory:");
		// 25 distinct lines: not JSON, low dup ratio, not a path list → classify returns null
		const text = Array.from({ length: 25 }, (_, i) => `unique line ${i} ${"x".repeat(40)}`).join("\n");
		expect(collapseText({ toolName: "bash", text, cache })).toBeNull();
		cache.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/collapse.test.ts`
Expected: FAIL — cannot find module `../src/collapse`.

- [ ] **Step 3: Write minimal implementation** — `src/collapse.ts`

```ts
import { classify, type ContentType } from "./router";
import { compressJson } from "./compressors/json";
import { compressLog } from "./compressors/log";
import { compressPaths } from "./compressors/paths";
import { hashContent, makeHandle } from "./handle";
import type { OriginalsCache } from "./cache";

const COMPRESSORS: Record<ContentType, (text: string) => string> = {
	json: compressJson,
	log: compressLog,
	paths: compressPaths,
};

export interface CollapseResult {
	collapsed: string;
	handle: string;
	type: ContentType;
}

/**
 * Deterministic single-pass collapse. Returns null to pass the result through
 * unchanged. On collapse, the raw original is saved to `cache` before returning.
 */
export function collapseText(params: {
	toolName: string;
	text: string;
	cache: OriginalsCache;
	now?: () => number;
}): CollapseResult | null {
	const { toolName, text, cache } = params;
	const type = classify(toolName, text);
	if (!type) return null;

	const compressed = COMPRESSORS[type](text);
	if (compressed.length >= text.length) return null;

	const hash = hashContent(text);
	const handle = makeHandle(type, hash);
	cache.save(hash, { raw: text, toolName, type, createdAt: (params.now ?? Date.now)() });

	const collapsed = `${handle} ${type} collapsed — use the expand tool with this handle for the raw original.\n${compressed}`;
	return { collapsed, handle, type };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/collapse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/collapse.ts agent/extensions/pi-context-collapse/test/collapse.test.ts
git commit -m "feat(collapse): orchestrator wiring router + compressors + cache"
```

---

### Task 9: Metrics

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/metrics.ts`
- Test: `agent/extensions/pi-context-collapse/test/metrics.test.ts`

**Interfaces:**
- Produces: `interface MetricEvent`, `class Metrics { constructor(path: string); record(event: MetricEvent): void }`

- [ ] **Step 1: Write the failing test** — `test/metrics.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Metrics } from "../src/metrics";

describe("Metrics", () => {
	it("appends one JSON line per event with a timestamp", () => {
		const dir = mkdtempSync(join(tmpdir(), "collapse-metrics-"));
		const path = join(dir, "m.jsonl");
		const metrics = new Metrics(path);
		metrics.record({ kind: "collapse", type: "json", toolName: "bash", rawTokens: 500, collapsedTokens: 50 });
		metrics.record({ kind: "expand", hash: "abc", type: "json", toolName: "bash" });
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!);
		expect(first.kind).toBe("collapse");
		expect(typeof first.ts).toBe("number");
		rmSync(dir, { recursive: true, force: true });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/metrics.test.ts`
Expected: FAIL — cannot find module `../src/metrics`.

- [ ] **Step 3: Write minimal implementation** — `src/metrics.ts`

```ts
import { appendFileSync } from "node:fs";

export interface MetricEvent {
	kind: "collapse" | "expand";
	type?: string;
	toolName?: string;
	rawTokens?: number;
	collapsedTokens?: number;
	hash?: string;
}

/** Append-only JSONL metrics sink. Best-effort: never throws into the tool path. */
export class Metrics {
	constructor(private readonly path: string) {}

	record(event: MetricEvent): void {
		try {
			appendFileSync(this.path, `${JSON.stringify({ ...event, ts: Date.now() })}\n`);
		} catch {
			// metrics are best-effort; swallow IO errors so collapse never fails on logging
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/metrics.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/metrics.ts agent/extensions/pi-context-collapse/test/metrics.test.ts
git commit -m "feat(collapse): jsonl metrics sink"
```

---

### Task 10: Expand tool

**Files:**
- Create: `agent/extensions/pi-context-collapse/src/expand.ts`
- Test: `agent/extensions/pi-context-collapse/test/expand.test.ts`

**Interfaces:**
- Consumes: `parseHandle` (Task 2), `OriginalsCache` (Task 3), `Metrics` (Task 9)
- Produces: `registerExpandTool(pi: ExtensionAPI, cache: OriginalsCache, metrics: Metrics): void`. Registers a tool named `expand` with params `{ handle: string; offset?: number }` returning `{ content: [{type:"text",text}], isError? }`.

- [ ] **Step 1: Write the failing test** — `test/expand.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExpandTool } from "../src/expand";
import { OriginalsCache } from "../src/cache";
import { Metrics } from "../src/metrics";
import { makeHandle } from "../src/handle";

function fakePi() {
	const tools: Record<string, any> = {};
	return {
		pi: { registerTool: (t: any) => { tools[t.name] = t; }, on: () => {} } as any,
		tools,
	};
}

describe("registerExpandTool", () => {
	it("returns the cached raw original for a handle", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collapse-expand-"));
		const cache = new OriginalsCache(":memory:");
		cache.save("abc123abc123", { raw: "THE RAW ORIGINAL", toolName: "bash", type: "json", createdAt: 1 });
		const { pi, tools } = fakePi();
		registerExpandTool(pi, cache, new Metrics(join(dir, "m.jsonl")));
		const res = await tools.expand.execute("id", { handle: makeHandle("json", "abc123abc123") });
		expect(res.content[0].text).toContain("THE RAW ORIGINAL");
		expect(res.isError).toBeFalsy();
		cache.close();
		rmSync(dir, { recursive: true, force: true });
	});
	it("errors when no original is cached", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collapse-expand-"));
		const cache = new OriginalsCache(":memory:");
		const { pi, tools } = fakePi();
		registerExpandTool(pi, cache, new Metrics(join(dir, "m.jsonl")));
		const res = await tools.expand.execute("id", { handle: "deadbeef0000" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("E_NO_ORIGINAL");
		cache.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/expand.test.ts`
Expected: FAIL — cannot find module `../src/expand`.

- [ ] **Step 3: Write minimal implementation** — `src/expand.ts`

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { parseHandle } from "./handle";
import type { OriginalsCache } from "./cache";
import type { Metrics } from "./metrics";

const MAX_EXPAND_CHARS = 16000;

/** Register the `expand` tool: returns the raw original (sliced) for a collapse handle. */
export function registerExpandTool(
	pi: ExtensionAPI,
	cache: OriginalsCache,
	metrics: Metrics,
): void {
	pi.registerTool({
		name: "expand",
		label: "Expand",
		description:
			"Return the raw original of a collapsed tool result. Pass the ⟦type:hash⟧ handle (or just its hash) shown in a collapsed result. Use offset to page through large originals.",
		parameters: Type.Object({
			handle: Type.String({ description: "the ⟦type:hash⟧ marker or the bare hash" }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "character offset to start from (default 0)" }),
			),
		}),
		async execute(_toolCallId: string, params: { handle: string; offset?: number }) {
			const parsed = parseHandle(params.handle) ?? { hash: params.handle.trim() };
			const rec = cache.get(parsed.hash);
			if (!rec) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[E_NO_ORIGINAL] No cached original for handle "${params.handle}". It may have expired or never been collapsed.`,
						},
					],
					isError: true,
				};
			}
			metrics.record({ kind: "expand", hash: parsed.hash, type: rec.type, toolName: rec.toolName });
			const offset = params.offset ?? 0;
			const slice = rec.raw.slice(offset, offset + MAX_EXPAND_CHARS);
			const end = offset + slice.length;
			const more =
				end < rec.raw.length
					? `\n\n[Showing chars ${offset}-${end} of ${rec.raw.length}. Use offset=${end} to continue.]`
					: "";
			return { content: [{ type: "text" as const, text: slice + more }] };
		},
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/expand.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/src/expand.ts agent/extensions/pi-context-collapse/test/expand.test.ts
git commit -m "feat(collapse): expand tool for raw recovery"
```

---

### Task 11: Wire index.ts (tool_result handler)

**Files:**
- Create: `agent/extensions/pi-context-collapse/index.ts`
- Test: `agent/extensions/pi-context-collapse/test/index.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `default function (pi: ExtensionAPI): void` — registers the `expand` tool and a `tool_result` handler that returns `{ content }` to replace collapsed results, or `undefined` to pass through.

- [ ] **Step 1: Write the failing test** — `test/index.test.ts`

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index";
import { parseHandle } from "../src/handle";

function harness() {
	const tools: Record<string, any> = {};
	let resultHandler: ((e: any) => any) | undefined;
	const pi = {
		registerTool: (t: any) => { tools[t.name] = t; },
		on: (event: string, handler: (e: any) => any) => {
			if (event === "tool_result") resultHandler = handler;
		},
	} as any;
	return { pi, tools, fire: (e: any) => resultHandler!(e) };
}

const textEvent = (toolName: string, text: string, isError = false) => ({
	type: "tool_result", toolName, toolCallId: "c1", input: {}, isError,
	content: [{ type: "text", text }], details: undefined,
});

describe("context-collapse extension", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "collapse-idx-")); process.env.PI_COLLAPSE_DIR = dir; });
	afterEach(() => { delete process.env.PI_COLLAPSE_DIR; rmSync(dir, { recursive: true, force: true }); });

	it("registers the expand tool", () => {
		const h = harness();
		register(h.pi);
		expect(h.tools.expand).toBeDefined();
	});
	it("collapses a big JSON bash result and embeds a handle", () => {
		const h = harness();
		register(h.pi);
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, n: i })));
		const out = h.fire(textEvent("bash", raw));
		expect(out?.content?.[0]?.text).toBeDefined();
		expect(parseHandle(out.content[0].text)?.type).toBe("json");
	});
	it("passes through read results untouched", () => {
		const h = harness();
		register(h.pi);
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ n: i })));
		expect(h.fire(textEvent("read", raw))).toBeUndefined();
	});
	it("passes through error results untouched", () => {
		const h = harness();
		register(h.pi);
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ n: i })));
		expect(h.fire(textEvent("bash", raw, true))).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL — cannot find module `../index`.

- [ ] **Step 3: Write minimal implementation** — `index.ts`

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { OriginalsCache } from "./src/cache";
import { Metrics } from "./src/metrics";
import { collapseText } from "./src/collapse";
import { registerExpandTool } from "./src/expand";
import { estimateTokens } from "./src/tokens";

export default function (pi: ExtensionAPI): void {
	const dir = process.env.PI_COLLAPSE_DIR ?? process.cwd();
	const cache = new OriginalsCache(join(dir, ".pi-collapse.db"));
	const metrics = new Metrics(join(dir, ".pi-collapse-metrics.jsonl"));

	registerExpandTool(pi, cache, metrics);

	pi.on("tool_result", (event) => {
		if (event.isError) return;
		if (event.content.length !== 1 || event.content[0]?.type !== "text") return;
		const text = (event.content[0] as { type: "text"; text: string }).text;

		const result = collapseText({ toolName: event.toolName, text, cache });
		if (!result) return;

		metrics.record({
			kind: "collapse",
			type: result.type,
			toolName: event.toolName,
			rawTokens: estimateTokens(text),
			collapsedTokens: estimateTokens(result.collapsed),
		});

		return { content: [{ type: "text" as const, text: result.collapsed }] };
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add `.gitignore`** — `agent/extensions/pi-context-collapse/.gitignore`

```
node_modules/
.pi-collapse.db
.pi-collapse.db-*
.pi-collapse-metrics.jsonl
```

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-context-collapse/index.ts agent/extensions/pi-context-collapse/test/index.test.ts agent/extensions/pi-context-collapse/.gitignore
git commit -m "feat(collapse): wire tool_result handler and expand tool"
```

---

### Task 12: End-to-end integration test + full suite + typecheck

**Files:**
- Test: `agent/extensions/pi-context-collapse/test/integration.test.ts`

**Interfaces:**
- Consumes: `default` export (Task 11), the registered `expand` tool, `parseHandle`.

- [ ] **Step 1: Write the failing test** — `test/integration.test.ts`

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index";
import { parseHandle } from "../src/handle";

describe("collapse → expand round trip", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "collapse-int-")); process.env.PI_COLLAPSE_DIR = dir; });
	afterEach(() => { delete process.env.PI_COLLAPSE_DIR; rmSync(dir, { recursive: true, force: true }); });

	it("collapses a result, then expand returns the exact raw original", async () => {
		const tools: Record<string, any> = {};
		let resultHandler: ((e: any) => any) | undefined;
		const pi = {
			registerTool: (t: any) => { tools[t.name] = t; },
			on: (ev: string, h: (e: any) => any) => { if (ev === "tool_result") resultHandler = h; },
		} as any;
		register(pi);

		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, n: i })));
		const collapsed = resultHandler!({
			type: "tool_result", toolName: "bash", toolCallId: "c1", input: {},
			isError: false, content: [{ type: "text", text: raw }], details: undefined,
		});

		const handle = parseHandle(collapsed.content[0].text);
		expect(handle).not.toBeNull();
		expect(collapsed.content[0].text.length).toBeLessThan(raw.length);

		const expanded = await tools.expand.execute("id", {
			handle: `⟦${handle!.type}:${handle!.hash}⟧`,
		});
		expect(expanded.content[0].text).toBe(raw);
	});
});
```

- [ ] **Step 2: Run test to verify it fails (or passes from existing wiring)**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL first if any wiring gap; otherwise PASS. If it fails on a wiring gap, fix the gap in the relevant `src/` file (no new behavior), re-run until PASS.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all test files PASS.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-context-collapse/test/integration.test.ts
git commit -m "test(collapse): end-to-end collapse→expand round trip"
```

---

## Manual verification (after Task 12)

1. Start pi: `PI_COLLAPSE_DIR=<a temp dir> pi` (so the db/metrics land somewhere writable).
2. Run a tool that emits bulky JSON, e.g. `bash echo '<big json>'` or `gh api ...` — observe the result rendered as `⟦json:...⟧ json collapsed …` + summary.
3. Ask the agent to call `expand` with that handle — observe the raw original returned.
4. Run `read <file>` — observe the hashline output is **unchanged** (no handle), confirming the exempt path.
5. Inspect `<dir>/.pi-collapse-metrics.jsonl` — one `collapse` line per collapse, one `expand` line per expand. This is the expand-rate data for tuning the kill-thresholds.

## Out of scope for v0 (do not build)

- Code/AST compression (no `web-tree-sitter`).
- Prose/HTML summarization (needs a model — violates deterministic constraint).
- Cross-session / cross-agent shared cache, TTL eviction (v0 keeps everything for the db's lifetime).
- KV-cache prefix alignment beyond the write-once property (already cache-friendly).

# Capability Index (Phase 1: Skills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `pi-capability-index` PI extension — Phase 1 (skills): a derived FTS5/BM25 index over all skills, `capability_search`/`capability_activate`/`capability_add` tools, switchable **loadouts** with a frontend-ready CRUD service, a prompt-slimming hook that replaces PI's full `<available_skills>` block with the active loadout, and promote-on-use.

**Architecture:** A separate PI extension (sibling to `pi-research-library`) that reuses the same `better-sqlite3` + FTS5 + content-hash patterns. Skills are indexed from PI's own exported `loadSkills()` (catches even `disable-model-invocation` skills). One kind-agnostic index + `capability_search`; activation dispatches through a per-kind **Activator** (only `SkillActivator` in Phase 1; `Tool`/`Mcp` are later phases). The `before_agent_start` hook computes `active = loadout ∪ session-activated ∪ promoted` and rewrites the skills block to just those, failing open if PI's markers are absent.

**Tech Stack:** TypeScript (ESM, loaded via jiti — no build step), `better-sqlite3` (FTS5), `typebox` v1, `yaml`, `vitest`. Reference spec: `docs/superpowers/specs/2026-06-12-capability-index-design.md`. Reference sibling implementation: `~/.pi/agent/extensions/pi-research-library/`.

---

## Subagent Execution Strategy

This plan is optimized for **subagent-driven-development**: a fresh subagent per task, two-stage review between tasks. Tasks are grouped into **waves**; within a wave, tasks are independent and can be dispatched **in parallel** (separate subagents, no shared edits). Across waves there are hard dependencies — do not start a wave until the prior wave's tasks are reviewed and merged.

| Wave | Tasks | Parallel? | Depends on | Review depth |
|---|---|---|---|---|
| **0 — Scaffold** | T1 | serial (one task) | — | **Light** (infra; the FTS5 feasibility assert is the real check) |
| **1 — Primitives** | T2 types · T3 paths · T4 schema+db · T5 flatten | **Yes, 4-wide** | T1 | Light (pure, well-specified) |
| **2 — Engine** | T6 index-store · T7 search | **Yes, 2-wide** | T1–T5 | **Deep** (ranking correctness is load-bearing) |
| **3 — Sources & state** | T8 harvest · T9 loadouts · T10 prompt-rewrite · T11 usage+promotion | **Yes, 4-wide** | T2,T4,T6 | Medium; **Deep** on T10 (fail-open) |
| **4 — Activation** | T12 activators | serial | T2,T8 | Medium |
| **5 — Context & policy** | T13 cap-context · T14 policy | **Yes, 2-wide** | T6,T8,T9,T11 | Medium |
| **6 — Tools** | T15 search-tool · T16 activate-tool · T17 add-tool · T18 loadout-tool | **Yes, 4-wide** | T13 | Medium |
| **7 — Wire & prove** | T19 commands · T20 index.ts · T21 e2e+jiti smoke | serial | all | **Deep** (integration is where wiring bugs hide) |

**Dispatch rules for the orchestrator:**
- Give each subagent: this plan path, the **one task** it owns (by number), the spec path, and the sibling-extension path for pattern reference. Tell it explicitly *"implement only Task N; do not touch other tasks' files."*
- **Calibrate review depth** (per the table): for Light tasks, skim the diff + confirm tests pass. For **Deep** tasks (T7 ranking, T10 fail-open, T21 integration) read the test assertions critically and verify edge cases listed in the task.
- **Parallel-wave hygiene:** every task lists its exact Create/Test files; within a wave these never overlap, so parallel subagents can't collide. The only shared file is `index.ts` (T20, serial) — no parallel task writes it.
- After each wave: run the **full** `npm test` (not just the task's file) before opening the next wave, to catch cross-module breakage early.
- T21 ends with a **jiti load smoke test** (the same one that validated `pi-research-library`) — this is the gate that proves the extension actually loads in PI.

---

## File Structure

All paths under `~/.pi/agent/extensions/pi-capability-index/` (new extension, its own git repo + `node_modules`).

```
package.json            # type:module, pi.extensions:["./index.ts"], deps: better-sqlite3, typebox, yaml
tsconfig.json           # mirror sibling; exclude test/**
.gitignore              # node_modules/, *.db, .archive/
index.ts                # wiring: tools + commands + session_start + tool_execution_end + before_agent_start
src/
  types.ts              # Kind, Capability, SearchText, CapHit, CapSearchResult, Loadout, ActivationResult
  paths.ts              # capabilityRoot/dbPath/loadoutsPath/skillsTargetDir
  hash.ts               # sha256 (verbatim from sibling)
  schema.ts             # DDL: capability, capability_fts (multi-column), usage
  db.ts                 # openDb (verbatim from sibling)
  flatten.ts            # flattenParams(jsonSchema) -> string (used by tool/mcp kinds; tested now)
  index-store.ts        # upsertCapability / getCapability / getCapabilities / deleteCapability / allIds
  search.ts             # capabilitySearch(db, query, {kind,k}) -> CapSearchResult (weighted BM25)
  harvest/skills.ts     # skillToCapability(skill) + harvestSkills({cwd}) via loadSkills()
  loadouts.ts           # LoadoutService (CRUD over loadouts.yaml) — the frontend-ready API
  prompt-rewrite.ts     # slimSkillsBlock(prompt, skills) -> string (fail-open)
  usage.ts              # recordUsage / topRecentIds
  promotion.ts          # computeActiveIds(loadoutIds, sessionIds, db, ceiling)
  activators/
    types.ts            # Activator interface, ActivationResult
    skill.ts            # SkillActivator
    registry.ts         # activatorFor(kind)
  cap-context.ts        # buildCapContext() -> CapContext { db, projectDb, loadouts, sessionActive, refresh() }
  policy.ts             # capPolicy(style)
  commands.ts           # /loadout, /cap-reindex
  tools/
    capability_search.ts
    capability_activate.ts
    capability_add.ts
    loadout.ts
test/
  <one *.test.ts per src module>
```

---

## Task 1: Scaffold the extension package

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/hash.ts`, `src/db.ts`, `src/schema.ts`, `test/feasibility.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pi-capability-index",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "vitest run", "check": "tsc --noEmit" },
  "dependencies": {
    "better-sqlite3": "^11.8.0",
    "typebox": "^1.1.24",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.2",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "allowScripts": { "better-sqlite3@11.10.0": true }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "noEmit": true, "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts"],
  "exclude": ["test/**/*.ts", "node_modules"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
*.db
*.db-*
.archive/
dist/
```

- [ ] **Step 4: Create `src/hash.ts`** (verbatim from sibling)

```ts
import { createHash } from "node:crypto";
export function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
```

- [ ] **Step 5: Create `src/schema.ts`** (the multi-column FTS5 index — spec §4)

```ts
export const DDL = `
CREATE TABLE IF NOT EXISTS capability(
  id TEXT PRIMARY KEY, kind TEXT, source TEXT, name TEXT, summary TEXT,
  activation TEXT, content_hash TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_capability_kind ON capability(kind);
CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(id UNINDEXED, name, summary, params);
CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, count INTEGER DEFAULT 0, last_used_at TEXT);
`;
```

- [ ] **Step 6: Create `src/db.ts`** (verbatim from sibling)

```ts
import Database from "better-sqlite3";
import { DDL } from "./schema.js";
import fs from "node:fs"; import path from "node:path";

export type DB = Database.Database;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
  return db;
}
```

- [ ] **Step 7: Write the feasibility test** (proves weighted multi-column BM25 works on this platform)

`test/feasibility.test.ts`:
```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";

test("FTS5 weighted multi-column bm25 ranks name-matches above param-matches", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO capability_fts(id,name,summary,params) VALUES (?,?,?,?)")
    .run("a", "screenshot", "capture the page", "");
  db.prepare("INSERT INTO capability_fts(id,name,summary,params) VALUES (?,?,?,?)")
    .run("b", "navigate", "go to a url", "screenshot: optional bool");
  const rows = db.prepare(
    "SELECT id, bm25(capability_fts, 0.0, 8.0, 4.0, 1.0) AS bm FROM capability_fts WHERE capability_fts MATCH ? ORDER BY bm"
  ).all('"screenshot"') as { id: string; bm: number }[];
  expect(rows[0].id).toBe("a"); // name hit (weight 8) beats params hit (weight 1)
});
```

- [ ] **Step 8: Install and run feasibility**

Run: `cd ~/.pi/agent/extensions/pi-capability-index && npm install && npm test`
Expected: feasibility test PASSES. If FTS5 is missing, STOP and report (same gate the sibling cleared).

- [ ] **Step 9: Commit**

```bash
git init && git add -A && git commit -m "chore: scaffold pi-capability-index + FTS5 feasibility"
```

---

## Task 2: Core types

**Files:**
- Create: `src/types.ts`
- Test: `test/types.test.ts`

- [ ] **Step 1: Write the failing test**

`test/types.test.ts`:
```ts
import { test, expect } from "vitest";
import type { Capability, Loadout, CapSearchResult } from "../src/types.js";

test("Capability and Loadout shapes are usable", () => {
  const cap: Capability = {
    id: "skill:brainstorming", kind: "skill", source: "/skills", name: "brainstorming",
    summary: "turn ideas into designs",
    searchText: { name: "brainstorming", summary: "turn ideas into designs", params: "" },
    activation: { skillDir: "/skills/brainstorming", filePath: "/skills/brainstorming/SKILL.md" },
  };
  const lo: Loadout = { name: "base", description: "", skills: [cap.id], tools: [], mcp: [] };
  const res: CapSearchResult = { hits: [], confidence: "low", next_steps: [] };
  expect(cap.kind).toBe("skill");
  expect(lo.skills[0]).toBe("skill:brainstorming");
  expect(res.confidence).toBe("low");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL ("Cannot find module ../src/types.js").

- [ ] **Step 3: Write `src/types.ts`**

```ts
export type Kind = "skill" | "tool" | "mcp";

export interface SearchText { name: string; summary: string; params: string; }

export interface Capability {
  id: string;            // `${kind}:${localName}` — stable, collision-free
  kind: Kind;
  source: string;        // skill baseDir / "pi" / mcp server id
  name: string;
  summary: string;
  searchText: SearchText;
  activation: unknown;    // kind-specific; consumed only by the Activator
}

export interface CapHit { id: string; kind: Kind; name: string; summary: string; score: number; }

export interface CapSearchResult {
  hits: CapHit[];
  confidence: "high" | "medium" | "low";
  next_steps: string[];
}

export interface Loadout {
  name: string;
  description: string;
  skills: string[];      // capability ids
  tools: string[];       // reserved (Phase 2)
  mcp: string[];         // reserved (Phase 3)
}

export interface ActivationResult { available: "now" | "next-turn"; payload?: unknown; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/types.test.ts && git commit -m "feat: capability core types"
```

---

## Task 3: Paths

**Files:**
- Create: `src/paths.ts`
- Test: `test/paths.test.ts`

- [ ] **Step 1: Write the failing test**

`test/paths.test.ts`:
```ts
import { test, expect } from "vitest";
import { capabilityRoot, dbPath, loadoutsPath, authoredSkillsDir } from "../src/paths.js";

test("paths derive from a root", () => {
  const root = capabilityRoot("/home/u", "global");
  expect(root.replace(/\\/g, "/")).toBe("/home/u/.pi/capabilities");
  expect(dbPath(root).replace(/\\/g, "/")).toBe("/home/u/.pi/capabilities/index.db");
  expect(loadoutsPath(root).replace(/\\/g, "/")).toBe("/home/u/.pi/capabilities/loadouts.yaml");
  // authored skills live in a sibling dir that refresh() always harvests (so they survive prune)
  expect(authoredSkillsDir(root).replace(/\\/g, "/")).toBe("/home/u/.pi/skills");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/paths.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/paths.ts`**

```ts
import path from "node:path";

export function capabilityRoot(base: string, _scope: "global" | "project"): string {
  return path.join(base, ".pi", "capabilities");
}
export function dbPath(root: string): string { return path.join(root, "index.db"); }
export function loadoutsPath(root: string): string { return path.join(root, "loadouts.yaml"); }
// Authored skills go in a sibling of the capabilities root (~/.pi/skills); refresh() always
// harvests this dir so authored skills are never pruned.
export function authoredSkillsDir(root: string): string { return path.join(root, "..", "skills"); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/paths.test.ts && git commit -m "feat: capability paths"
```

---

## Task 4: (folded into Task 1)

`src/schema.ts` and `src/db.ts` are created in Task 1 (Steps 5–6) so the feasibility test can run. No separate task. Skip to Task 5.

---

## Task 5: Param flattening (for tool/mcp kinds; tested now, used in Phases 2–3)

**Files:**
- Create: `src/flatten.ts`
- Test: `test/flatten.test.ts`

- [ ] **Step 1: Write the failing test**

`test/flatten.test.ts`:
```ts
import { test, expect } from "vitest";
import { flattenParams } from "../src/flatten.js";

test("flattens JSON-schema params to a searchable string with names, descriptions, enums", () => {
  const schema = {
    type: "object",
    properties: {
      sheet_id: { type: "string", description: "the spreadsheet id" },
      mode: { type: "string", enum: ["read", "write"] },
    },
  };
  const out = flattenParams(schema);
  expect(out).toContain("sheet_id");
  expect(out).toContain("the spreadsheet id");
  expect(out).toContain("read");
  expect(out).toContain("write");
});

test("empty/invalid schema yields empty string", () => {
  expect(flattenParams(undefined)).toBe("");
  expect(flattenParams({})).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flatten.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/flatten.ts`**

```ts
const CAP = 200; // per-field truncation to bound size

export function flattenParams(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "";
  const parts: string[] = [];
  walk(schema as Record<string, unknown>, "", parts);
  return parts.join(" ").slice(0, 4000).trim();
}

function walk(node: Record<string, unknown>, prefix: string, out: string[]): void {
  const props = node["properties"];
  if (props && typeof props === "object") {
    for (const [key, val] of Object.entries(props as Record<string, unknown>)) {
      const v = (val ?? {}) as Record<string, unknown>;
      const fieldName = prefix ? `${prefix}.${key}` : key;
      let line = fieldName;
      if (typeof v["description"] === "string") line += `: ${(v["description"] as string).slice(0, CAP)}`;
      if (Array.isArray(v["enum"])) line += ` (enum: ${(v["enum"] as unknown[]).join("|")})`;
      out.push(line);
      if (v["properties"]) walk(v, fieldName, out);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/flatten.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flatten.ts test/flatten.test.ts && git commit -m "feat: param flattening for capability search text"
```

---

## Task 6: Index store (upsert / get / delete + FTS sync)

**Files:**
- Create: `src/index-store.ts`
- Test: `test/index-store.test.ts`

- [ ] **Step 1: Write the failing test**

`test/index-store.test.ts`:
```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { upsertCapability, getCapability, getCapabilities, deleteCapability, allIds } from "../src/index-store.js";
import type { Capability } from "../src/types.js";

function cap(id: string, name: string, summary = "", params = ""): Capability {
  return { id, kind: "skill", source: "/s", name, summary,
    searchText: { name, summary, params }, activation: { filePath: "/s/" + name } };
}

test("upsert inserts then updates idempotently; fts stays in sync", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:a", "alpha", "first"));
  upsertCapability(db, cap("skill:a", "alpha", "second")); // update, not duplicate
  const got = getCapability(db, "skill:a");
  expect(got?.summary).toBe("second");
  const ftsCount = db.prepare("SELECT count(*) n FROM capability_fts WHERE id=?").get("skill:a") as { n: number };
  expect(ftsCount.n).toBe(1); // no orphaned fts rows
});

test("getCapabilities returns many; delete removes from both tables", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:a", "alpha"));
  upsertCapability(db, cap("skill:b", "beta"));
  expect(getCapabilities(db, ["skill:a", "skill:b"]).length).toBe(2);
  deleteCapability(db, "skill:a");
  expect(getCapability(db, "skill:a")).toBeNull();
  expect((db.prepare("SELECT count(*) n FROM capability_fts WHERE id=?").get("skill:a") as any).n).toBe(0);
  expect(allIds(db)).toEqual(["skill:b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/index-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/index-store.ts`**

```ts
import type { DB } from "./db.js";
import type { Capability } from "./types.js";
import { sha256 } from "./hash.js";

export function upsertCapability(db: DB, cap: Capability): void {
  const hash = sha256(JSON.stringify(cap.searchText) + "|" + JSON.stringify(cap.activation));
  db.prepare(`INSERT INTO capability(id,kind,source,name,summary,activation,content_hash,updated_at)
    VALUES (@id,@kind,@source,@name,@summary,@activation,@hash,@now)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, source=excluded.source, name=excluded.name,
      summary=excluded.summary, activation=excluded.activation, content_hash=excluded.content_hash,
      updated_at=excluded.updated_at`)
    .run({ id: cap.id, kind: cap.kind, source: cap.source, name: cap.name, summary: cap.summary,
      activation: JSON.stringify(cap.activation), hash, now: new Date().toISOString() });
  db.prepare("DELETE FROM capability_fts WHERE id=?").run(cap.id);
  db.prepare("INSERT INTO capability_fts(id,name,summary,params) VALUES (?,?,?,?)")
    .run(cap.id, cap.searchText.name, cap.searchText.summary, cap.searchText.params);
}

export function getCapability(db: DB, id: string): Capability | null {
  const r = db.prepare("SELECT * FROM capability WHERE id=?").get(id) as any;
  return r ? rowToCap(r) : null;
}
export function getCapabilities(db: DB, ids: string[]): Capability[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM capability WHERE id IN (${ph})`).all(...ids) as any[];
  return rows.map(rowToCap);
}
export function deleteCapability(db: DB, id: string): void {
  db.prepare("DELETE FROM capability WHERE id=?").run(id);
  db.prepare("DELETE FROM capability_fts WHERE id=?").run(id);
}
export function allIds(db: DB): string[] {
  return (db.prepare("SELECT id FROM capability ORDER BY id").all() as any[]).map((r) => r.id);
}

function rowToCap(r: any): Capability {
  return { id: r.id, kind: r.kind, source: r.source, name: r.name, summary: r.summary,
    searchText: { name: r.name, summary: r.summary, params: "" },
    activation: safeJson(r.activation, {}) };
}
function safeJson<T>(s: string, fb: T): T { try { return JSON.parse(s) as T; } catch { return fb; } }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/index-store.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/index-store.ts test/index-store.test.ts && git commit -m "feat: capability index store with fts sync"
```

---

## Task 7: Search (weighted BM25, kind filter, normalization, confidence)

**Files:**
- Create: `src/search.ts`
- Test: `test/search.test.ts`

**Review note (Deep):** verify (a) name match outranks summary/param match, (b) `kind` filter excludes other kinds, (c) confidence buckets, (d) no-match returns empty + low.

- [ ] **Step 1: Write the failing test**

`test/search.test.ts`:
```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { upsertCapability } from "../src/index-store.js";
import { capabilitySearch } from "../src/search.js";
import type { Capability } from "../src/types.js";

function cap(id: string, kind: any, name: string, summary: string, params = ""): Capability {
  return { id, kind, source: "/s", name, summary, searchText: { name, summary, params }, activation: {} };
}

test("name match outranks param-only match; results carry id/kind/name", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:screenshot", "skill", "screenshot", "capture page"));
  upsertCapability(db, cap("mcp:nav", "mcp", "navigate", "go to url", "screenshot: bool"));
  const res = capabilitySearch(db, "screenshot", {});
  expect(res.hits[0].id).toBe("skill:screenshot");
  expect(["high", "medium", "low"]).toContain(res.confidence);
});

test("kind filter restricts the set", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:a", "skill", "deploy", "deploy the app"));
  upsertCapability(db, cap("mcp:b", "mcp", "deploy", "deploy via api"));
  const onlyMcp = capabilitySearch(db, "deploy", { kind: "mcp" });
  expect(onlyMcp.hits.every((h) => h.kind === "mcp")).toBe(true);
  expect(onlyMcp.hits.length).toBe(1);
});

test("no match -> empty hits, low confidence", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:a", "skill", "alpha", "unrelated"));
  const res = capabilitySearch(db, "zzzznotacword", {});
  expect(res.hits.length).toBe(0);
  expect(res.confidence).toBe("low");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/search.ts`**

```ts
import type { DB } from "./db.js";
import type { CapHit, CapSearchResult, Kind } from "./types.js";

export interface CapSearchOpts { kind?: Kind | "all"; k?: number; }

interface Row { id: string; kind: Kind; name: string; summary: string; bm: number; }

export function capabilitySearch(db: DB, query: string, opts: CapSearchOpts): CapSearchResult {
  const k = opts.k ?? 8;
  const match = ftsQuery(query);
  let sql = `SELECT f.id, c.kind, c.name, c.summary,
      bm25(capability_fts, 0.0, 8.0, 4.0, 1.0) AS bm
    FROM capability_fts f JOIN capability c ON c.id=f.id
    WHERE capability_fts MATCH @q`;
  const params: Record<string, unknown> = { q: match };
  if (opts.kind && opts.kind !== "all") { sql += ` AND c.kind=@kind`; params["kind"] = opts.kind; }
  sql += ` ORDER BY bm LIMIT 200`;
  let rows: Row[] = [];
  try { rows = db.prepare(sql).all(params) as Row[]; } catch { rows = []; }

  // bm25: lower (more negative) is better -> min-max invert to 0..1
  const bms = rows.map((r) => r.bm);
  const min = Math.min(...bms), max = Math.max(...bms);
  const hits: (CapHit & { _n: number })[] = rows.map((r) => {
    const norm = rows.length === 0 || max === min ? (rows.length ? 1 : 0) : (max - r.bm) / (max - min);
    return { id: r.id, kind: r.kind, name: r.name, summary: r.summary, score: round(norm), _n: norm };
  });
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, k).map(({ _n, ...h }) => h);

  const best = hits.length ? hits[0]._n : 0;
  const confidence = best >= 0.66 ? "high" : best >= 0.33 ? "medium" : "low";
  const next_steps: string[] = [];
  if (hits.length === 0 || confidence === "low")
    next_steps.push("No strong capability match — broaden the query, drop the kind filter, or it may not exist yet.");
  return { hits: top, confidence: hits.length === 0 ? "low" : confidence, next_steps };
}

function ftsQuery(q: string): string {
  const terms = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return terms.map((t) => `"${t}"`).join(" OR ") || '""';
}
function round(n: number): number { return Math.round(n * 1000) / 1000; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/search.ts test/search.test.ts && git commit -m "feat: weighted BM25 capability search with kind filter"
```

---

## Task 8: Harvest skills via PI's loadSkills()

**Files:**
- Create: `src/harvest/skills.ts`
- Test: `test/harvest-skills.test.ts`

- [ ] **Step 1: Write the failing test** (mapper is pure; harvest is integration via a temp SKILL.md)

`test/harvest-skills.test.ts`:
```ts
import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skillToCapability, harvestSkills } from "../src/harvest/skills.js";

test("skillToCapability maps PI Skill -> Capability", () => {
  const cap = skillToCapability({
    name: "brainstorming", description: "turn ideas into designs",
    filePath: "/skills/brainstorming/SKILL.md", baseDir: "/skills/brainstorming",
    sourceInfo: {} as any, disableModelInvocation: true,
  } as any);
  expect(cap.id).toBe("skill:brainstorming");
  expect(cap.kind).toBe("skill");
  expect(cap.searchText.summary).toBe("turn ideas into designs");
  expect((cap.activation as any).filePath).toBe("/skills/brainstorming/SKILL.md");
});

test("harvestSkills loads a packaged skill from an explicit path (incl. disabled)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-skills-"));
  const sdir = path.join(dir, "demo"); mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, "SKILL.md"),
    "---\nname: demo\ndescription: a demo skill\ndisable-model-invocation: true\n---\nbody\n");
  const caps = harvestSkills({ cwd: dir, skillPaths: [sdir], includeDefaults: false });
  const demo = caps.find((c) => c.name === "demo");
  expect(demo).toBeTruthy();                 // disabled skill is still harvested (G8 resolved)
  expect(demo!.summary).toBe("a demo skill");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/harvest-skills.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/harvest/skills.ts`**

```ts
import { loadSkills, getAgentDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { Capability } from "../types.js";

export function skillToCapability(s: Skill): Capability {
  return {
    id: `skill:${s.name}`,
    kind: "skill",
    source: s.baseDir,
    name: s.name,
    summary: s.description,
    searchText: { name: s.name, summary: s.description, params: "" },
    activation: { skillDir: s.baseDir, filePath: s.filePath },
  };
}

export interface HarvestOpts { cwd: string; skillPaths?: string[]; includeDefaults?: boolean; }

export function harvestSkills(opts: HarvestOpts): Capability[] {
  const { skills } = loadSkills({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    skillPaths: opts.skillPaths ?? [],
    includeDefaults: opts.includeDefaults ?? true,
  });
  // de-dup by id (a skill discoverable from multiple roots collapses to one row)
  const byId = new Map<string, Capability>();
  for (const s of skills) { const c = skillToCapability(s); byId.set(c.id, c); }
  return [...byId.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/harvest-skills.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/harvest/skills.ts test/harvest-skills.test.ts && git commit -m "feat: harvest skills via PI loadSkills (catches hidden skills)"
```

---

## Task 9: LoadoutService (CRUD over loadouts.yaml — the frontend-ready API)

**Files:**
- Create: `src/loadouts.ts`
- Test: `test/loadouts.test.ts`

- [ ] **Step 1: Write the failing test**

`test/loadouts.test.ts`:
```ts
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoadoutService } from "../src/loadouts.js";

function svc() {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-lo-"));
  return new LoadoutService(path.join(dir, "loadouts.yaml"));
}

test("CRUD lifecycle + active pointer + granular add/remove", () => {
  const s = svc();
  s.createLoadout("frontend", { description: "ui", skills: ["skill:frontend-design"] });
  expect(s.listLoadouts().map((l) => l.name)).toContain("frontend");
  s.addCapability("frontend", "skill:css");
  expect(s.getLoadout("frontend")!.skills).toContain("skill:css");
  s.removeCapability("frontend", "skill:css");
  expect(s.getLoadout("frontend")!.skills).not.toContain("skill:css");
  s.setActive("frontend");
  expect(s.getActive()).toBe("frontend");
  s.updateLoadout("frontend", { description: "ui work" });
  expect(s.getLoadout("frontend")!.description).toBe("ui work");
  s.deleteLoadout("frontend");
  expect(s.getLoadout("frontend")).toBeNull();
});

test("getActiveSkillIds returns core ∪ active loadout skills", () => {
  const s = svc();
  s.setCore(["skill:debugging"]);
  s.createLoadout("base", { skills: ["skill:brainstorming"] });
  s.setActive("base");
  const ids = s.getActiveSkillIds();
  expect(ids).toContain("skill:debugging");
  expect(ids).toContain("skill:brainstorming");
});

test("validate flags ids not present in a provided known-set (drift)", () => {
  const s = svc();
  s.createLoadout("base", { skills: ["skill:gone", "skill:here"] });
  const missing = s.validate("base", new Set(["skill:here"]));
  expect(missing).toEqual(["skill:gone"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loadouts.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/loadouts.ts`**

```ts
import fs from "node:fs"; import path from "node:path";
import { parse, stringify } from "yaml";
import type { Loadout } from "./types.js";

interface FileShape { core: string[]; active: string; loadouts: Record<string, Loadout>; }

export class LoadoutService {
  constructor(private file: string) {}

  private read(): FileShape {
    if (!fs.existsSync(this.file)) return { core: [], active: "base", loadouts: {} };
    try { const d = parse(fs.readFileSync(this.file, "utf-8")) ?? {};
      return { core: d.core ?? [], active: d.active ?? "base", loadouts: d.loadouts ?? {} };
    } catch { return { core: [], active: "base", loadouts: {} }; }
  }
  private write(d: FileShape): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, stringify(d));
  }

  listLoadouts(): Loadout[] { return Object.values(this.read().loadouts); }
  getLoadout(name: string): Loadout | null { return this.read().loadouts[name] ?? null; }

  createLoadout(name: string, init: Partial<Loadout> = {}): void {
    const d = this.read();
    d.loadouts[name] = { name, description: init.description ?? "",
      skills: init.skills ?? [], tools: init.tools ?? [], mcp: init.mcp ?? [] };
    this.write(d);
  }
  updateLoadout(name: string, patch: Partial<Loadout>): void {
    const d = this.read(); const cur = d.loadouts[name]; if (!cur) return;
    d.loadouts[name] = { ...cur, ...patch, name: patch.name ?? cur.name };
    if (patch.name && patch.name !== name) { d.loadouts[patch.name] = d.loadouts[name]; delete d.loadouts[name]; }
    this.write(d);
  }
  addCapability(name: string, capId: string): void {
    const d = this.read(); const lo = d.loadouts[name]; if (!lo) return;
    const list = capId.startsWith("mcp:") ? lo.mcp : capId.startsWith("tool:") ? lo.tools : lo.skills;
    if (!list.includes(capId)) list.push(capId);
    this.write(d);
  }
  removeCapability(name: string, capId: string): void {
    const d = this.read(); const lo = d.loadouts[name]; if (!lo) return;
    lo.skills = lo.skills.filter((x) => x !== capId);
    lo.tools = lo.tools.filter((x) => x !== capId);
    lo.mcp = lo.mcp.filter((x) => x !== capId);
    this.write(d);
  }
  deleteLoadout(name: string): void { const d = this.read(); delete d.loadouts[name]; this.write(d); }

  getActive(): string { return this.read().active; }
  setActive(name: string): void { const d = this.read(); d.active = name; this.write(d); }
  setCore(ids: string[]): void { const d = this.read(); d.core = ids; this.write(d); }

  getActiveSkillIds(): string[] {
    const d = this.read();
    const lo = d.loadouts[d.active];
    const ids = new Set<string>([...d.core, ...(lo?.skills ?? [])]);
    return [...ids].filter((id) => id.startsWith("skill:"));
  }
  validate(name: string, known: Set<string>): string[] {
    const lo = this.getLoadout(name); if (!lo) return [];
    return [...lo.skills, ...lo.tools, ...lo.mcp].filter((id) => !known.has(id));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/loadouts.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/loadouts.ts test/loadouts.test.ts && git commit -m "feat: LoadoutService CRUD over loadouts.yaml"
```

---

## Task 10: Prompt-slimming (replace skills block, fail-open)

**Files:**
- Create: `src/prompt-rewrite.ts`
- Test: `test/prompt-rewrite.test.ts`

**Review note (Deep):** the fail-open path is a correctness requirement — a parse miss must return the prompt **byte-for-byte unchanged**, never empty or partial.

- [ ] **Step 1: Write the failing test**

`test/prompt-rewrite.test.ts`:
```ts
import { test, expect } from "vitest";
import { slimSkillsBlock } from "../src/prompt-rewrite.js";

const BLOCK = `intro text
<available_skills>
  <skill><name>alpha</name><description>A</description><location>/s/alpha/SKILL.md</location></skill>
  <skill><name>beta</name><description>B</description><location>/s/beta/SKILL.md</location></skill>
  <skill><name>gamma</name><description>C</description><location>/s/gamma/SKILL.md</location></skill>
</available_skills>
trailing text`;

test("replaces the block with only the provided skills + a search pointer", () => {
  const out = slimSkillsBlock(BLOCK, [
    { name: "beta", summary: "B", activation: { filePath: "/s/beta/SKILL.md" } } as any,
  ]);
  expect(out).toContain("intro text");
  expect(out).toContain("trailing text");
  expect(out).toContain("beta");
  expect(out).not.toContain("<name>alpha</name>");
  expect(out).not.toContain("<name>gamma</name>");
  expect(out).toContain("capability_search");
});

test("fail-open: no markers -> prompt returned unchanged", () => {
  const p = "a system prompt with no skills block at all";
  expect(slimSkillsBlock(p, [])).toBe(p);
});

test("empty active set still emits a valid (pointer-only) block", () => {
  const out = slimSkillsBlock(BLOCK, []);
  expect(out).toContain("capability_search");
  expect(out).not.toContain("<name>alpha</name>");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prompt-rewrite.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/prompt-rewrite.ts`**

```ts
import type { Capability } from "./types.js";

const OPEN = "<available_skills>";
const CLOSE = "</available_skills>";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function renderBlock(skills: Capability[]): string {
  const lines = [OPEN];
  for (const s of skills) {
    const loc = (s.activation as { filePath?: string })?.filePath ?? "";
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(s.name)}</name>`);
    lines.push(`    <description>${escapeXml(s.summary)}</description>`);
    lines.push(`    <location>${escapeXml(loc)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("  <!-- More skills available — call capability_search to find them by task. -->");
  lines.push(CLOSE);
  return lines.join("\n");
}

export function slimSkillsBlock(prompt: string, active: Capability[]): string {
  const start = prompt.indexOf(OPEN);
  const end = prompt.indexOf(CLOSE);
  if (start === -1 || end === -1 || end < start) return prompt; // fail open
  const before = prompt.slice(0, start);
  const after = prompt.slice(end + CLOSE.length);
  return before + renderBlock(active) + after;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/prompt-rewrite.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/prompt-rewrite.ts test/prompt-rewrite.test.ts && git commit -m "feat: skills-block slimming with fail-open"
```

---

## Task 11: Usage tracking + promotion set

**Files:**
- Create: `src/usage.ts`, `src/promotion.ts`
- Test: `test/promotion.test.ts`

- [ ] **Step 1: Write the failing test**

`test/promotion.test.ts`:
```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { recordUsage, topRecentIds } from "../src/usage.js";
import { computeActiveIds } from "../src/promotion.js";

test("recordUsage counts and orders by recency", () => {
  const db = openDb(":memory:");
  recordUsage(db, "skill:a");
  recordUsage(db, "skill:a");
  recordUsage(db, "skill:b");
  const recent = topRecentIds(db, 5, new Set());
  expect(recent).toContain("skill:a");
  expect(recent).toContain("skill:b");
});

test("computeActiveIds = loadout ∪ session ∪ promoted, capped by ceiling, no dupes", () => {
  const db = openDb(":memory:");
  recordUsage(db, "skill:hot1");
  recordUsage(db, "skill:hot2");
  recordUsage(db, "skill:hot3");
  const active = computeActiveIds({
    loadoutIds: ["skill:base"], sessionIds: new Set(["skill:sess"]), db, ceiling: 2,
  });
  expect(active).toContain("skill:base");
  expect(active).toContain("skill:sess");
  // at most `ceiling` promoted beyond loadout+session
  const promoted = active.filter((id) => id.startsWith("skill:hot"));
  expect(promoted.length).toBeLessThanOrEqual(2);
  expect(new Set(active).size).toBe(active.length); // no dupes
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/promotion.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/usage.ts`**

```ts
import type { DB } from "./db.js";

export function recordUsage(db: DB, id: string): void {
  db.prepare(`INSERT INTO usage(id,count,last_used_at) VALUES (?,1,?)
    ON CONFLICT(id) DO UPDATE SET count=count+1, last_used_at=excluded.last_used_at`)
    .run(id, new Date().toISOString());
}

export function topRecentIds(db: DB, limit: number, exclude: Set<string>): string[] {
  const rows = db.prepare("SELECT id FROM usage ORDER BY last_used_at DESC, count DESC LIMIT 200").all() as { id: string }[];
  const out: string[] = [];
  for (const r of rows) { if (exclude.has(r.id)) continue; out.push(r.id); if (out.length >= limit) break; }
  return out;
}
```

- [ ] **Step 4: Write `src/promotion.ts`**

```ts
import type { DB } from "./db.js";
import { topRecentIds } from "./usage.js";

export interface ActiveSetInput {
  loadoutIds: string[];
  sessionIds: Set<string>;
  db: DB;
  ceiling: number;          // max auto-promoted beyond loadout+session
}

export function computeActiveIds(input: ActiveSetInput): string[] {
  const base = new Set<string>([...input.loadoutIds, ...input.sessionIds]);
  const promoted = topRecentIds(input.db, input.ceiling, base);
  return [...base, ...promoted];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/promotion.test.ts`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add src/usage.ts src/promotion.ts test/promotion.test.ts && git commit -m "feat: usage tracking + promotion active-set with ceiling"
```

---

## Task 12: Activators (interface + SkillActivator + registry)

**Files:**
- Create: `src/activators/types.ts`, `src/activators/skill.ts`, `src/activators/registry.ts`
- Test: `test/activators.test.ts`

- [ ] **Step 1: Write the failing test**

`test/activators.test.ts`:
```ts
import { test, expect } from "vitest";
import { activatorFor } from "../src/activators/registry.js";
import type { Capability } from "../src/types.js";

test("SkillActivator marks the skill session-active and returns its file path", () => {
  const session = new Set<string>();
  const act = activatorFor("skill", { sessionActive: session });
  const cap: Capability = {
    id: "skill:demo", kind: "skill", source: "/s", name: "demo", summary: "d",
    searchText: { name: "demo", summary: "d", params: "" },
    activation: { skillDir: "/s/demo", filePath: "/s/demo/SKILL.md" },
  };
  const res = act.activate(cap);
  expect(res.available).toBe("next-turn");
  expect((res.payload as any).filePath).toBe("/s/demo/SKILL.md");
  expect(session.has("skill:demo")).toBe(true); // included in next prompt's slim block
});

test("unknown kind throws (Phase 2/3 not built yet)", () => {
  expect(() => activatorFor("tool", { sessionActive: new Set() })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/activators.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/activators/types.ts`**

```ts
import type { Capability, ActivationResult, Kind } from "../types.js";

export interface ActivatorDeps { sessionActive: Set<string>; }

export interface Activator {
  kind: Kind;
  activate(cap: Capability): ActivationResult;
}
```

- [ ] **Step 4: Write `src/activators/skill.ts`**

```ts
import type { Activator, ActivatorDeps } from "./types.js";
import type { Capability, ActivationResult } from "../types.js";

export class SkillActivator implements Activator {
  kind = "skill" as const;
  constructor(private deps: ActivatorDeps) {}
  activate(cap: Capability): ActivationResult {
    this.deps.sessionActive.add(cap.id); // appears in next turn's slimmed block
    const filePath = (cap.activation as { filePath?: string })?.filePath;
    return { available: "next-turn", payload: { filePath } };
  }
}
```

- [ ] **Step 5: Write `src/activators/registry.ts`**

```ts
import type { Kind } from "../types.js";
import type { Activator, ActivatorDeps } from "./types.js";
import { SkillActivator } from "./skill.js";

export function activatorFor(kind: Kind, deps: ActivatorDeps): Activator {
  switch (kind) {
    case "skill": return new SkillActivator(deps);
    // "tool"  -> Phase 2 (ToolActivator via setActiveTools)
    // "mcp"   -> Phase 3 (McpActivator via adapter proxy)
    default: throw new Error(`No activator for kind '${kind}' (built in a later phase)`);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/activators.test.ts`
Expected: PASS (both).

- [ ] **Step 7: Commit**

```bash
git add src/activators test/activators.test.ts && git commit -m "feat: Activator interface + SkillActivator + registry"
```

---

## Task 13: Capability context (open DBs, refresh from harvest)

**Files:**
- Create: `src/cap-context.ts`
- Test: `test/cap-context.test.ts`

- [ ] **Step 1: Write the failing test**

`test/cap-context.test.ts`:
```ts
import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCapContext } from "../src/cap-context.js";
import { capabilitySearch } from "../src/search.js";

test("buildCapContext opens db, writes gitignore, and refresh() indexes skills", () => {
  const home = mkdtempSync(path.join(tmpdir(), "cap-home-"));
  const sdir = path.join(home, "myskills", "demo"); mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, "SKILL.md"), "---\nname: demo\ndescription: indexed demo skill\n---\nbody\n");
  const ctx = buildCapContext({ homeDir: home, cwd: home, skillPaths: [path.join(home, "myskills", "demo")], includeDefaults: false });
  ctx.refresh();
  const res = capabilitySearch(ctx.db, "demo", { kind: "skill" });
  expect(res.hits.some((h) => h.id === "skill:demo")).toBe(true);
  expect(ctx.sessionActive.size).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cap-context.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/cap-context.ts`**

```ts
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import type { DB } from "./db.js";
import { openDb } from "./db.js";
import { capabilityRoot, dbPath, loadoutsPath, authoredSkillsDir } from "./paths.js";
import { harvestSkills } from "./harvest/skills.js";
import { upsertCapability, allIds, deleteCapability } from "./index-store.js";
import { LoadoutService } from "./loadouts.js";

export interface CapContext {
  db: DB;
  root: string;
  loadouts: LoadoutService;
  sessionActive: Set<string>;
  cwd: string;
  skillPaths: string[];
  includeDefaults: boolean;
  authoredDir: string;
  refresh(): number;
}

export interface CapContextOpts {
  homeDir?: string; cwd?: string; skillPaths?: string[]; includeDefaults?: boolean;
}

export function buildCapContext(opts?: CapContextOpts): CapContext {
  const home = opts?.homeDir ?? os.homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const root = capabilityRoot(home, "global");
  fs.mkdirSync(root, { recursive: true });
  ensureGitignore(root);
  const db = openDb(dbPath(root));
  const loadouts = new LoadoutService(loadoutsPath(root));
  const ctx: CapContext = {
    db, root, loadouts, sessionActive: new Set<string>(), cwd,
    skillPaths: opts?.skillPaths ?? [],
    includeDefaults: opts?.includeDefaults ?? true,
    authoredDir: authoredSkillsDir(root),
    refresh() {
      // always include the authored-skills dir so capability_add output survives the prune below;
      // filter to existing paths so a not-yet-created authored dir can't break harvest
      const paths = [...new Set([...ctx.skillPaths, ctx.authoredDir])].filter((p) => fs.existsSync(p));
      const caps = harvestSkills({ cwd: ctx.cwd, skillPaths: paths, includeDefaults: ctx.includeDefaults });
      const fresh = new Set(caps.map((c) => c.id));
      for (const c of caps) upsertCapability(db, c);
      // drop skills that disappeared from disk (keep tool/mcp rows from later phases)
      for (const id of allIds(db)) if (id.startsWith("skill:") && !fresh.has(id)) deleteCapability(db, id);
      return caps.length;
    },
  };
  return ctx;
}

function ensureGitignore(root: string) {
  const gi = path.join(root, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "index.db\nindex.db-*\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cap-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cap-context.ts test/cap-context.test.ts && git commit -m "feat: capability context with skill-refresh + prune"
```

---

## Task 14: Policy block

**Files:**
- Create: `src/policy.ts`
- Test: `test/policy.test.ts`

- [ ] **Step 1: Write the failing test**

`test/policy.test.ts`:
```ts
import { test, expect } from "vitest";
import { capPolicy } from "../src/policy.js";

test("compact policy names the search/activate tools; none is empty", () => {
  const p = capPolicy("compact");
  expect(p).toContain("capability_search");
  expect(p).toContain("capability_activate");
  expect(capPolicy("none")).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/policy.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/policy.ts`**

```ts
export type PolicyStyle = "full" | "compact" | "none";

export function capPolicy(style: PolicyStyle): string {
  if (style === "none") return "";
  const compact = `<capability-policy>
Only your active loadout's skills are shown above. Many more skills/tools exist but are not listed to save context. When a task needs a capability you don't see, call capability_search(query, { kind? }) to find it, then capability_activate(id) to load it (available next turn). Search 'all' kinds by default, or pass kind:'skill'|'tool'|'mcp' to scope.
</capability-policy>`;
  if (style === "compact") return compact;
  return compact.replace("</capability-policy>",
    `Frequently-used capabilities are auto-promoted into your active set; pin one permanently with /loadout promote <id>.
</capability-policy>`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts test/policy.test.ts && git commit -m "feat: capability policy block"
```

---

## Task 15: `capability_search` tool

**Files:**
- Create: `src/tools/capability_search.ts`
- Test: `test/tool-search.test.ts`

- [ ] **Step 1: Write the failing test**

`test/tool-search.test.ts`:
```ts
import { test, expect } from "vitest";
import { buildCapContext } from "../src/cap-context.js";
import { upsertCapability } from "../src/index-store.js";
import { makeCapabilitySearch } from "../src/tools/capability_search.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-ts-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}

test("tool returns JSON with hits filtered by kind", async () => {
  const c = ctx();
  upsertCapability(c.db, { id: "skill:deploy", kind: "skill", source: "/s", name: "deploy",
    summary: "deploy the app", searchText: { name: "deploy", summary: "deploy the app", params: "" }, activation: {} });
  const tool = makeCapabilitySearch(c);
  const out = await tool.execute("1", { query: "deploy", kind: "skill" });
  const parsed = JSON.parse(out.content[0].text);
  expect(parsed.hits[0].id).toBe("skill:deploy");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tool-search.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/tools/capability_search.ts`**

```ts
import { Type } from "typebox";
import type { CapContext } from "../cap-context.js";
import { capabilitySearch } from "../search.js";

export function makeCapabilitySearch(ctx: CapContext) {
  return {
    name: "capability_search",
    label: "Capability Search",
    description: "Find skills, tools, or MCP calls by task. Searches all three sets by default; pass kind to scope ('skill'|'tool'|'mcp'). Returns light ranked hits {id,kind,name,summary,score} — call capability_activate(id) to load one.",
    promptSnippet: "capability_search: find a skill/tool/mcp by task (ranked)",
    parameters: Type.Object({
      query: Type.String(),
      kind: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("tool"), Type.Literal("mcp"), Type.Literal("all")])),
      k: Type.Optional(Type.Number({ default: 8 })),
    }),
    async execute(_id: string, p: any) {
      const res = capabilitySearch(ctx.db, p.query, { kind: p.kind ?? "all", k: p.k ?? 8 });
      return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }], details: {} };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tool-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/capability_search.ts test/tool-search.test.ts && git commit -m "feat: capability_search tool"
```

---

## Task 16: `capability_activate` tool

**Files:**
- Create: `src/tools/capability_activate.ts`
- Test: `test/tool-activate.test.ts`

- [ ] **Step 1: Write the failing test**

`test/tool-activate.test.ts`:
```ts
import { test, expect } from "vitest";
import { buildCapContext } from "../src/cap-context.js";
import { upsertCapability } from "../src/index-store.js";
import { makeCapabilityActivate } from "../src/tools/capability_activate.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-ta-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}

test("activating a skill returns its path and marks it session-active", async () => {
  const c = ctx();
  upsertCapability(c.db, { id: "skill:demo", kind: "skill", source: "/s", name: "demo", summary: "d",
    searchText: { name: "demo", summary: "d", params: "" }, activation: { filePath: "/s/demo/SKILL.md" } });
  const tool = makeCapabilityActivate(c);
  const out = await tool.execute("1", { id: "skill:demo" });
  const parsed = JSON.parse(out.content[0].text);
  expect(parsed.available).toBe("next-turn");
  expect(parsed.payload.filePath).toBe("/s/demo/SKILL.md");
  expect(c.sessionActive.has("skill:demo")).toBe(true);
});

test("unknown id returns an error payload, not a throw", async () => {
  const c = ctx();
  const tool = makeCapabilityActivate(c);
  const out = await tool.execute("1", { id: "skill:missing" });
  expect(out.content[0].text).toContain("not found");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tool-activate.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/tools/capability_activate.ts`**

```ts
import { Type } from "typebox";
import type { CapContext } from "../cap-context.js";
import { getCapability } from "../index-store.js";
import { activatorFor } from "../activators/registry.js";

export function makeCapabilityActivate(ctx: CapContext) {
  return {
    name: "capability_activate",
    label: "Capability Activate",
    description: "Load a capability found via capability_search, by id. For a skill it returns the SKILL.md path to read (active next turn). For tools/mcp (later phases) it enables the tool.",
    promptSnippet: "capability_activate: load a found capability by id",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id: string, p: any) {
      const cap = getCapability(ctx.db, p.id);
      if (!cap) return { content: [{ type: "text" as const, text: `Capability '${p.id}' not found. Run capability_search first.` }], details: {} };
      try {
        const act = activatorFor(cap.kind, { sessionActive: ctx.sessionActive });
        const res = act.activate(cap);
        return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }], details: {} };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Cannot activate '${p.id}': ${(e as Error).message}` }], details: {} };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tool-activate.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/tools/capability_activate.ts test/tool-activate.test.ts && git commit -m "feat: capability_activate tool"
```

---

## Task 17: `capability_add` tool (scaffold a skill + dedup + secret scan)

**Files:**
- Create: `src/secrets.ts`, `src/tools/capability_add.ts`
- Test: `test/tool-add.test.ts`

- [ ] **Step 1: Write the failing test**

`test/tool-add.test.ts`:
```ts
import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildCapContext } from "../src/cap-context.js";
import { makeCapabilityAdd } from "../src/tools/capability_add.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-add-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}

test("creates a SKILL.md with frontmatter and indexes it", async () => {
  const c = ctx();
  const tool = makeCapabilityAdd(c);
  const out = await tool.execute("1", { name: "my-skill", description: "does a thing", body: "## Steps\nrun it" });
  const text = out.content[0].text;
  expect(text).toContain("my-skill");
  // file written under the skills target dir, with frontmatter
  const dir = path.join(c.root, "..", "skills", "my-skill", "SKILL.md");
  expect(existsSync(dir)).toBe(true);
  expect(readFileSync(dir, "utf-8")).toContain("name: my-skill");
});

test("refuses content containing a secret", async () => {
  const c = ctx();
  const tool = makeCapabilityAdd(c);
  const out = await tool.execute("1", { name: "leaky", description: "x", body: "key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD" });
  expect(out.content[0].text.toLowerCase()).toContain("secret");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tool-add.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/secrets.ts`**

```ts
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,                 // OpenAI-style
  /AKIA[0-9A-Z]{16}/,                    // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // PEM private key
  /ghp_[A-Za-z0-9]{30,}/,                // GitHub PAT
];
export function findSecret(text: string): boolean { return PATTERNS.some((p) => p.test(text)); }
```

- [ ] **Step 4: Write `src/tools/capability_add.ts`**

```ts
import { Type } from "typebox";
import fs from "node:fs"; import path from "node:path";
import type { CapContext } from "../cap-context.js";
import { capabilitySearch } from "../search.js";
import { findSecret } from "../secrets.js";
import { skillToCapability } from "../harvest/skills.js";
import { upsertCapability } from "../index-store.js";

export function makeCapabilityAdd(ctx: CapContext) {
  return {
    name: "capability_add",
    label: "Capability Add (author a skill)",
    description: "Author a new packaged skill: scaffolds a SKILL.md (frontmatter + body) and indexes it. Warns on a near-duplicate (dedup) and refuses content containing secrets.",
    promptSnippet: "capability_add: author + index a new skill",
    parameters: Type.Object({
      name: Type.String(),
      description: Type.String(),
      body: Type.String(),
    }),
    async execute(_id: string, p: any) {
      if (findSecret(p.body) || findSecret(p.description))
        return { content: [{ type: "text" as const, text: "Refused: content appears to contain a secret (API key / private key). Remove it and retry." }], details: {} };

      const dup = capabilitySearch(ctx.db, `${p.name} ${p.description}`, { kind: "skill", k: 1 });
      const warn = dup.confidence === "high" && dup.hits[0] ? ` (note: similar existing skill '${dup.hits[0].id}')` : "";

      const dir = path.join(ctx.authoredDir, p.name);   // ~/.pi/skills/<name>/ — harvested by refresh()
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "SKILL.md");
      const fm = `---\nname: ${p.name}\ndescription: ${p.description}\n---\n\n${p.body}\n`;
      fs.writeFileSync(file, fm);

      const cap = skillToCapability({ name: p.name, description: p.description, filePath: file,
        baseDir: dir, sourceInfo: {} as any, disableModelInvocation: false } as any);
      upsertCapability(ctx.db, cap);
      return { content: [{ type: "text" as const, text: `Authored skill '${p.name}' at ${file}${warn}` }], details: {} };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/tool-add.test.ts`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add src/secrets.ts src/tools/capability_add.ts test/tool-add.test.ts && git commit -m "feat: capability_add (author skill + dedup + secret scan)"
```

---

## Task 18: `loadout` tool (thin client over LoadoutService)

**Files:**
- Create: `src/tools/loadout.ts`
- Test: `test/tool-loadout.test.ts`

- [ ] **Step 1: Write the failing test**

`test/tool-loadout.test.ts`:
```ts
import { test, expect } from "vitest";
import { buildCapContext } from "../src/cap-context.js";
import { makeLoadout } from "../src/tools/loadout.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-lo-tool-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}

test("create, add, activate, list via the tool", async () => {
  const c = ctx();
  const tool = makeLoadout(c);
  await tool.execute("1", { action: "create", name: "frontend", description: "ui" });
  await tool.execute("2", { action: "add", name: "frontend", capability: "skill:css" });
  await tool.execute("3", { action: "activate", name: "frontend" });
  const out = await tool.execute("4", { action: "list" });
  const parsed = JSON.parse(out.content[0].text);
  expect(parsed.active).toBe("frontend");
  expect(parsed.loadouts.find((l: any) => l.name === "frontend").skills).toContain("skill:css");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tool-loadout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/tools/loadout.ts`**

```ts
import { Type } from "typebox";
import type { CapContext } from "../cap-context.js";

export function makeLoadout(ctx: CapContext) {
  return {
    name: "loadout",
    label: "Loadout",
    description: "Manage capability loadouts (named always-on working sets). actions: list | create | update | delete | activate | add | remove | promote. The active loadout's skills stay in context; everything else is search-on-demand.",
    promptSnippet: "loadout: switch/curate the always-on capability set",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"),
        Type.Literal("activate"), Type.Literal("add"), Type.Literal("remove"), Type.Literal("promote"),
      ]),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      capability: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any) {
      const lo = ctx.loadouts;
      switch (p.action) {
        case "create": lo.createLoadout(p.name, { description: p.description }); break;
        case "update": lo.updateLoadout(p.name, { description: p.description }); break;
        case "delete": lo.deleteLoadout(p.name); break;
        case "activate": lo.setActive(p.name); break;
        case "add": lo.addCapability(p.name, p.capability); break;
        case "remove": lo.removeCapability(p.name, p.capability); break;
        case "promote": { const active = lo.getActive(); lo.addCapability(active, p.capability); break; }
        case "list": default: break;
      }
      const payload = { active: lo.getActive(), loadouts: lo.listLoadouts() };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], details: {} };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tool-loadout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/loadout.ts test/tool-loadout.test.ts && git commit -m "feat: loadout tool over LoadoutService"
```

---

## Task 19: Slash commands

**Files:**
- Create: `src/commands.ts`
- Test: `test/commands.test.ts`

- [ ] **Step 1: Write the failing test** (verifies registration against a fake `pi`)

`test/commands.test.ts`:
```ts
import { test, expect } from "vitest";
import { buildCapContext } from "../src/cap-context.js";
import { registerCommands } from "../src/commands.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

test("registers /loadout and /cap-reindex", () => {
  const home = mkdtempSync(path.join(tmpdir(), "cap-cmd-"));
  const ctx = buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
  const names: string[] = [];
  const pi: any = { registerCommand: (n: string) => names.push(n) };
  registerCommands(pi, ctx);
  expect(names).toContain("loadout");
  expect(names).toContain("cap-reindex");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/commands.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CapContext } from "./cap-context.js";

export function registerCommands(pi: ExtensionAPI, ctx: CapContext) {
  pi.registerCommand("loadout", {
    description: "List or switch capability loadouts: /loadout [name]",
    handler: async (args, c) => {
      const name = (args ?? "").trim();
      if (name) { ctx.loadouts.setActive(name); if (c.hasUI) c.ui.notify(`Active loadout: ${name}`, "info"); return; }
      const list = ctx.loadouts.listLoadouts().map((l) => l.name).join(", ") || "(none)";
      if (c.hasUI) c.ui.notify(`Loadouts: ${list} · active: ${ctx.loadouts.getActive()}`, "info");
    },
  });
  pi.registerCommand("cap-reindex", {
    description: "Rebuild the capability index from skills on disk",
    handler: async (_args, c) => { const n = ctx.refresh(); if (c.hasUI) c.ui.notify(`Capability index: ${n} skill(s)`, "info"); },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts test/commands.test.ts && git commit -m "feat: /loadout and /cap-reindex commands"
```

---

## Task 20: Wire everything in `index.ts`

**Files:**
- Create: `index.ts`
- Test: `test/wiring.test.ts`

**Review note (Deep):** confirm the `before_agent_start` handler (a) slims the block to `computeActiveIds`, (b) appends policy, (c) fails open; and that `tool_execution_end` records skill reads.

- [ ] **Step 1: Write the failing test**

`test/wiring.test.ts`:
```ts
import { test, expect } from "vitest";
import extension from "../index.js";

test("default export registers tools, commands, and three hooks", () => {
  const tools: string[] = []; const commands: string[] = []; const events: string[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.push(t.name),
    registerCommand: (n: string) => commands.push(n),
    on: (e: string) => events.push(e),
  };
  extension(pi);
  expect(tools).toEqual(expect.arrayContaining(["capability_search", "capability_activate", "capability_add", "loadout"]));
  expect(commands).toEqual(expect.arrayContaining(["loadout", "cap-reindex"]));
  expect(events).toEqual(expect.arrayContaining(["session_start", "tool_execution_end", "before_agent_start"]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wiring.test.ts`
Expected: FAIL ("Cannot find module ../index.js").

- [ ] **Step 3: Write `index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCapContext } from "./src/cap-context.js";
import { registerCommands } from "./src/commands.js";
import { capPolicy, type PolicyStyle } from "./src/policy.js";
import { slimSkillsBlock } from "./src/prompt-rewrite.js";
import { computeActiveIds } from "./src/promotion.js";
import { getCapabilities } from "./src/index-store.js";
import { recordUsage } from "./src/usage.js";
import { makeCapabilitySearch } from "./src/tools/capability_search.js";
import { makeCapabilityActivate } from "./src/tools/capability_activate.js";
import { makeCapabilityAdd } from "./src/tools/capability_add.js";
import { makeLoadout } from "./src/tools/loadout.js";

const PROMOTION_CEILING = Number(process.env["CAP_PROMOTION_CEILING"] ?? "5");

export default function (pi: ExtensionAPI) {
  const ctx = buildCapContext();
  for (const make of [makeCapabilitySearch, makeCapabilityActivate, makeCapabilityAdd, makeLoadout])
    pi.registerTool(make(ctx) as any);
  registerCommands(pi, ctx);

  pi.on("session_start", async () => { try { ctx.refresh(); } catch { /* index is rebuildable */ } });

  // Usage signal for promotion: count a skill as "used" when its SKILL.md is read.
  pi.on("tool_execution_end", async (event: any) => {
    try {
      const name: string = event?.toolName ?? event?.name ?? "";
      const filePath: string = event?.args?.file_path ?? event?.input?.file_path ?? event?.args?.path ?? "";
      if (name === "read" && /(^|[\\/])SKILL\.md$/i.test(filePath)) {
        const seg = filePath.replace(/\\/g, "/").split("/"); const skillName = seg[seg.length - 2];
        if (skillName) recordUsage(ctx.db, `skill:${skillName}`);
      }
    } catch { /* best-effort */ }
  });

  pi.on("before_agent_start", async (event: any) => {
    try {
      const activeIds = computeActiveIds({
        loadoutIds: ctx.loadouts.getActiveSkillIds(),
        sessionIds: ctx.sessionActive,
        db: ctx.db,
        ceiling: PROMOTION_CEILING,
      });
      const skills = getCapabilities(ctx.db, activeIds).filter((c) => c.kind === "skill");
      let prompt = slimSkillsBlock(event.systemPrompt, skills);
      const policy = capPolicy((process.env["CAP_POLICY"] as PolicyStyle) || "compact");
      if (policy) prompt += "\n\n" + policy;
      return { systemPrompt: prompt };
    } catch {
      return; // fail open: leave PI's prompt untouched
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + type-check**

Run: `npm test && npm run check`
Expected: ALL tests PASS; `tsc --noEmit` clean. (Tool `execute` arity differs from PI's `ToolDefinition`; the `as any` at registration absorbs it, matching the sibling extension.)

- [ ] **Step 6: Commit**

```bash
git add index.ts test/wiring.test.ts && git commit -m "feat: wire tools, commands, and hooks (slim + policy + promotion)"
```

---

## Task 21: End-to-end + jiti load smoke test

**Files:**
- Create: `test/e2e.test.ts`, `scripts/smoke-load.mjs`

**Review note (Deep):** this is the gate that proves the extension *loads in PI* and the happy path works end-to-end.

- [ ] **Step 1: Write the e2e test**

`test/e2e.test.ts`:
```ts
import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import path from "node:path";
import { buildCapContext } from "../src/cap-context.js";
import { makeCapabilitySearch } from "../src/tools/capability_search.js";
import { makeCapabilityActivate } from "../src/tools/capability_activate.js";
import { slimSkillsBlock } from "../src/prompt-rewrite.js";
import { computeActiveIds } from "../src/promotion.js";
import { getCapabilities } from "../src/index-store.js";

test("harvest -> search -> activate -> next prompt includes the activated skill", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "cap-e2e-"));
  const sdir = path.join(home, "skills", "retry"); mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, "SKILL.md"), "---\nname: retry\ndescription: exponential backoff retries\n---\nbody\n");
  const ctx = buildCapContext({ homeDir: home, cwd: home, skillPaths: [sdir], includeDefaults: false });
  ctx.refresh();

  const found = JSON.parse((await makeCapabilitySearch(ctx).execute("1", { query: "backoff" })).content[0].text);
  expect(found.hits[0].id).toBe("skill:retry");

  await makeCapabilityActivate(ctx).execute("2", { id: "skill:retry" });
  expect(ctx.sessionActive.has("skill:retry")).toBe(true);

  const ids = computeActiveIds({ loadoutIds: [], sessionIds: ctx.sessionActive, db: ctx.db, ceiling: 5 });
  const skills = getCapabilities(ctx.db, ids);
  const prompt = slimSkillsBlock("x\n<available_skills>\n</available_skills>\ny", skills);
  expect(prompt).toContain("retry");
});
```

- [ ] **Step 2: Run the e2e test**

Run: `npx vitest run test/e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Write `scripts/smoke-load.mjs`** (loads the extension through PI's own jiti, like the sibling)

```js
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jitiPath = require.resolve("jiti", { paths: [require.resolve("@earendil-works/pi-coding-agent/package.json")] });
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(pathToFileURL("./index.ts").href);
const ext = mod.default ?? mod;
const tools = []; const commands = []; const events = [];
ext({ registerTool: (t) => tools.push(t.name), registerCommand: (n) => commands.push(n), on: (e) => events.push(e) });
console.log("LOAD_OK", JSON.stringify({ tools, commands, events }));
if (tools.length !== 4 || events.length !== 3) { console.error("UNEXPECTED SURFACE"); process.exit(1); }
```

- [ ] **Step 4: Run the smoke load**

Run: `node scripts/smoke-load.mjs`
Expected: prints `LOAD_OK {"tools":["capability_search","capability_activate","capability_add","loadout"],"commands":["loadout","cap-reindex"],"events":["session_start","tool_execution_end","before_agent_start"]}` and exits 0.
(If jiti isn't resolvable from the PI package, fall back to `npx jiti index.ts` after a tiny wrapper that calls the default export — but the PI-jiti path mirrors how PI actually loads it.)

- [ ] **Step 5: Commit**

```bash
git add test/e2e.test.ts scripts/smoke-load.mjs && git commit -m "test: e2e flow + jiti load smoke"
```

---

## Definition of Done (Phase 1)

- [ ] All 21 tasks committed; `npm test` green; `npm run check` clean; `node scripts/smoke-load.mjs` prints `LOAD_OK`.
- [ ] Live check in PI (manual): launch `pi` from any dir; confirm `capability_search`/`capability_activate`/`capability_add`/`loadout` are present, `~/.pi/capabilities/{index.db,loadouts.yaml,.gitignore}` are created, and the system prompt's `<available_skills>` block is slimmed to the active loadout (verify via `/export-html` or the prompt inspector).
- [ ] **Follow-on phases (separate plans, gated by the spec's feasibility checks):** Phase 2 `ToolActivator` via `setActiveTools`; Phase 3 `McpActivator` + adopt the MCP transport package.

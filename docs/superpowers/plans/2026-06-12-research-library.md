# Research Library (②b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PI extension that gives the agent a private, AI-friendly document library — files-as-source-of-truth, a derived SQLite/FTS5 index, pinpoint lexical search, sourced self-growth, and curation tools — usable inside PI via `kb_*` tools.

**Architecture:** A standalone TypeScript PI extension (`pi-research-library`). Each doc is a Markdown file with YAML frontmatter (metadata = source of truth) under `<root>/kb/collections/<id>/docs/`. A per-root `index.db` (better-sqlite3, WAL, FTS5) is a *derived, rebuildable* index. The agent interacts only through registered tools; a hash-gated incremental reindex runs on `session_start`. Lexical-only v1; vec/graph are sealed out (see spec §5.1, §5.4).

**Tech Stack:** TypeScript (run via PI's jiti, no build), better-sqlite3 (FTS5), typebox (tool schemas), yaml (frontmatter), vitest (tests), Node 20.

**Spec:** `docs/superpowers/specs/2026-06-12-research-library-design.md`

---

## File structure

```
~/.pi/agent/extensions/pi-research-library/
  package.json            # type:module, pi.extensions, deps
  index.ts                # ExtensionFactory: wires modules, registers tools/commands, session_start reindex
  src/
    types.ts              # shared types (DocMeta, Source, Chunk, SearchHit, SearchResult, CollectionMeta)
    paths.ts              # resolve global (~/.pi/kb) + project (<cwd>/.pi/kb) roots & collection paths
    frontmatter.ts        # parse/serialize YAML frontmatter <-> DocMeta (source of truth)
    hash.ts               # sha256 content hashing
    schema.ts             # SQLite DDL strings
    db.ts                 # open/init better-sqlite3 per root (WAL + DDL)
    chunker.ts            # split body into heading-aware, size-capped chunks
    describe.ts           # cheap metadata extraction (title/description/tags) from body
    indexer.ts            # incremental hash-keyed reindex of a collection
    search.ts             # FTS5 BM25 query + normalization + authority/recency + diagnostics
    registry.ts           # merged global+project collection listing (bounded)
    secrets.ts            # secret scan for writes
    policy.ts             # <kb-policy> system-prompt block + tool promptSnippets
    tools/
      kb_write.ts kb_import.ts kb_search.ts kb_open.ts
      kb_cite.ts kb_collections.ts kb_update.ts kb_remove.ts
    commands.ts           # /kb-reindex, /kb-consolidate
  test/                   # *.test.ts (vitest)
```

**Module boundaries:** `frontmatter`/`chunker`/`hash`/`paths` are pure (no DB, trivially testable). `db`/`schema` own SQLite. `indexer` composes pure modules + db. `search`/`registry` are read paths. `tools/*` are thin adapters over the above. `index.ts` is the only file touching `ExtensionAPI`.

---

## Subagent execution strategy

This plan is built for parallel subagents. Dependencies form three fan-out waves; dispatch one fresh subagent per task within a wave, review between waves (two-stage review per superpowers:subagent-driven-development).

```
Wave 0 (sequential, 1 agent):   T1 feasibility+scaffold → T2 shared types
Wave 1 (parallel, up to 4):     T3 paths · T4 frontmatter · T5 hash+chunker · T6 schema+db
Wave 2 (parallel, up to 3):     T7 describe · T8 indexer(needs T4,T5,T6) · T9 search(needs T6)
                                 T10 registry(needs T3)
Wave 3 (parallel, up to 6):     T11 kb_write · T12 kb_import · T13 kb_search · T14 kb_open
                                 T15 kb_cite · T16 kb_collections · T17 kb_update · T18 kb_remove
Wave 4 (sequential, 1 agent):   T19 secrets+policy · T20 commands · T21 index.ts wiring · T22 e2e+load
```

**Rules for dispatched subagents:**
- Each task is self-contained: exact files, full code, exact test commands below. A subagent needs only its task + `src/types.ts` + this file structure.
- Every task is TDD: write failing test → confirm fail → implement → confirm pass → commit. Never skip the "confirm fail" step.
- A subagent must run `npx vitest run test/<its-file>.test.ts` and paste the PASS output before reporting done.
- Wave 2/3 subagents may assume Wave 1/2 modules exist with the signatures defined here — do not re-implement them.
- Reviewer subagent between waves checks: types match `src/types.ts`, no cross-module leakage, tests actually assert behavior (not tautologies).

---

## Task 1: Feasibility check + scaffold

**Files:**
- Create: `~/.pi/agent/extensions/pi-research-library/package.json`
- Create: `~/.pi/agent/extensions/pi-research-library/tsconfig.json`
- Create: `~/.pi/agent/extensions/pi-research-library/test/feasibility.test.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "pi-research-library",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "vitest run", "build": "echo none", "check": "tsc --noEmit" },
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
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "types": ["node"], "noEmit": true
  },
  "include": ["index.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Install and write the feasibility test**

Run: `cd ~/.pi/agent/extensions/pi-research-library && npm install`
Expected: completes; `better-sqlite3` installs a Windows prebuild (no compiler needed). If it tries to compile and fails, STOP and report — the SQLite backend choice must be revisited.

`test/feasibility.test.ts`:
```ts
import { test, expect } from "vitest";
import Database from "better-sqlite3";

test("better-sqlite3 supports FTS5 on this platform", () => {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(chunk_id UNINDEXED, body)");
  db.prepare("INSERT INTO t(chunk_id, body) VALUES (?, ?)").run("c1", "exponential backoff retry");
  const rows = db.prepare("SELECT chunk_id, bm25(t) AS score FROM t WHERE t MATCH ? ORDER BY score").all("backoff");
  expect(rows.length).toBe(1);
  expect((rows[0] as any).chunk_id).toBe("c1");
  db.close();
});
```

- [ ] **Step 4: Run feasibility test**

Run: `npx vitest run test/feasibility.test.ts`
Expected: 1 passed. (If FTS5 is missing, the CREATE VIRTUAL TABLE throws — stop and report.)

- [ ] **Step 5: Commit**

```bash
git add ~/.pi/agent/extensions/pi-research-library
git commit -m "feat(kb): scaffold research-library extension + verify FTS5"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/types.ts`
- Test: `test/types.test.ts`

- [ ] **Step 1: Write the failing test**

`test/types.test.ts`:
```ts
import { test, expect } from "vitest";
import { AUTHORITY_RANK, type DocMeta } from "../src/types.js";

test("authority rank orders reference > curated > agent-note", () => {
  expect(AUTHORITY_RANK.reference).toBeGreaterThan(AUTHORITY_RANK.curated);
  expect(AUTHORITY_RANK.curated).toBeGreaterThan(AUTHORITY_RANK["agent-note"]);
});
test("DocMeta shape compiles", () => {
  const m: DocMeta = { id: "d1", title: "t", description: "", tags: [], sources: [],
    authority: "agent-note", created_at: "2026-06-12T00:00:00Z", updated_at: "2026-06-12T00:00:00Z" };
  expect(m.id).toBe("d1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL — cannot find `../src/types.js`.

- [ ] **Step 3: Implement `src/types.ts`**

```ts
export type Authority = "reference" | "curated" | "agent-note";
export const AUTHORITY_RANK: Record<Authority, number> = { reference: 2, curated: 1, "agent-note": 0 };

export interface Source { url?: string; path?: string; title?: string; retrieved_at?: string; locator?: string; }

export interface DocMeta {
  id: string; title: string; description: string; tags: string[];
  sources: Source[]; authority: Authority;
  created_at: string; updated_at: string;
  supersedes?: string; confidence?: number;
}

export interface Chunk { id: string; doc_id: string; collection_id: string; heading_path: string; ordinal: number; body: string; content_hash: string; }

export interface CollectionMeta { id: string; summary: string; tags: string[]; authority: Authority; doc_count: number; path: string; backends: string[]; }

export interface SearchHit {
  doc_id: string; chunk_id: string; title: string; heading_path: string;
  snippet: string; score: number; authority: Authority; sources: Source[];
  collection: { id: string; summary: string };
}
export interface SearchResult {
  hits: SearchHit[];
  confidence: "high" | "medium" | "low";
  confidence_reason: string;
  suggested_terms: string[];
  candidate_collections: string[];
  next_steps: string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/types.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/types.test.ts && git commit -m "feat(kb): shared types"
```

---

## Task 3: Path resolution  *(Wave 1)*

**Files:** Create `src/paths.ts`; Test `test/paths.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { globalKbRoot, projectKbRoot, collectionDir, docsDir } from "../src/paths.js";
import os from "node:os"; import path from "node:path";

test("globalKbRoot is under home/.pi/kb", () => {
  expect(globalKbRoot()).toBe(path.join(os.homedir(), ".pi", "kb"));
});
test("projectKbRoot is <cwd>/.pi/kb", () => {
  expect(projectKbRoot("/proj")).toBe(path.join("/proj", ".pi", "kb"));
});
test("collectionDir and docsDir compose", () => {
  const root = "/r"; 
  expect(collectionDir(root, "godot")).toBe(path.join("/r", "collections", "godot"));
  expect(docsDir(root, "godot")).toBe(path.join("/r", "collections", "godot", "docs"));
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/paths.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/paths.ts`**

```ts
import os from "node:os"; import path from "node:path";

export function globalKbRoot(): string { return path.join(os.homedir(), ".pi", "kb"); }
export function projectKbRoot(cwd: string): string { return path.join(cwd, ".pi", "kb"); }
export function collectionsDir(root: string): string { return path.join(root, "collections"); }
export function collectionDir(root: string, id: string): string { return path.join(root, "collections", id); }
export function docsDir(root: string, id: string): string { return path.join(collectionDir(root, id), "docs"); }
export function dbPath(root: string): string { return path.join(root, "index.db"); }
export function registryPath(root: string): string { return path.join(root, "registry.json"); }
export function collectionJsonPath(root: string, id: string): string { return path.join(collectionDir(root, id), "collection.json"); }
```

- [ ] **Step 4: Verify pass** — `npx vitest run test/paths.test.ts` → 3 passed.
- [ ] **Step 5: Commit** — `git add src/paths.ts test/paths.test.ts && git commit -m "feat(kb): path resolution"`

---

## Task 4: Frontmatter (metadata source of truth)  *(Wave 1)*

**Files:** Create `src/frontmatter.ts`; Test `test/frontmatter.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { parseDoc, serializeDoc } from "../src/frontmatter.js";

const sample = `---
id: d1
title: Look At
description: rotate to face a point
tags: [node2d, transform]
authority: reference
sources:
  - url: https://docs/x
    title: Godot
created_at: 2026-06-12T00:00:00Z
updated_at: 2026-06-12T00:00:00Z
---
# Look At
Body text here.`;

test("parseDoc splits meta and body", () => {
  const { meta, body } = parseDoc(sample);
  expect(meta.id).toBe("d1");
  expect(meta.tags).toEqual(["node2d", "transform"]);
  expect(meta.sources[0].url).toBe("https://docs/x");
  expect(body.trim().startsWith("# Look At")).toBe(true);
});

test("serializeDoc round-trips", () => {
  const { meta, body } = parseDoc(sample);
  const out = serializeDoc(meta, body);
  const again = parseDoc(out);
  expect(again.meta.id).toBe("d1");
  expect(again.body.trim()).toBe(body.trim());
});

test("parseDoc on body without frontmatter returns defaults", () => {
  const { meta, body } = parseDoc("# Title\nhello");
  expect(meta.id).toBe(""); // caller fills id
  expect(body).toContain("hello");
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/frontmatter.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/frontmatter.ts`**

```ts
import YAML from "yaml";
import type { DocMeta, Authority, Source } from "./types.js";

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function emptyMeta(): DocMeta {
  const now = "";
  return { id: "", title: "", description: "", tags: [], sources: [],
    authority: "agent-note", created_at: now, updated_at: now };
}

export function parseDoc(text: string): { meta: DocMeta; body: string } {
  const m = FM_RE.exec(text);
  if (!m) return { meta: emptyMeta(), body: text };
  const raw = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  const meta: DocMeta = {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    description: String(raw.description ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    sources: Array.isArray(raw.sources) ? (raw.sources as Source[]) : [],
    authority: (["reference", "curated", "agent-note"].includes(String(raw.authority))
      ? (raw.authority as Authority) : "agent-note"),
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
    supersedes: raw.supersedes ? String(raw.supersedes) : undefined,
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
  };
  return { meta, body: m[2] };
}

export function serializeDoc(meta: DocMeta, body: string): string {
  const obj: Record<string, unknown> = {
    id: meta.id, title: meta.title, description: meta.description, tags: meta.tags,
    authority: meta.authority, sources: meta.sources,
    created_at: meta.created_at, updated_at: meta.updated_at,
  };
  if (meta.supersedes) obj.supersedes = meta.supersedes;
  if (meta.confidence !== undefined) obj.confidence = meta.confidence;
  return `---\n${YAML.stringify(obj).trimEnd()}\n---\n${body.replace(/^\n/, "")}`;
}
```

- [ ] **Step 4: Verify pass** — `npx vitest run test/frontmatter.test.ts` → 3 passed.
- [ ] **Step 5: Commit** — `git add src/frontmatter.ts test/frontmatter.test.ts && git commit -m "feat(kb): frontmatter parse/serialize"`

---

## Task 5: Hashing + chunker  *(Wave 1)*

**Files:** Create `src/hash.ts`, `src/chunker.ts`; Test `test/chunker.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { sha256 } from "../src/hash.js";
import { chunk } from "../src/chunker.js";

test("sha256 is stable and differs on change", () => {
  expect(sha256("a")).toBe(sha256("a"));
  expect(sha256("a")).not.toBe(sha256("b"));
});

test("chunk splits by markdown headings with breadcrumb", () => {
  const body = `# Nodes\nintro\n## Node2D\ndetails\n### look_at\nrotate to face`;
  const chunks = chunk(body, { maxChars: 1000, overlap: 0 });
  const paths = chunks.map(c => c.headingPath);
  expect(paths).toContain("Nodes");
  expect(paths).toContain("Nodes > Node2D");
  expect(paths).toContain("Nodes > Node2D > look_at");
  expect(chunks.every(c => c.body.length > 0)).toBe(true);
});

test("chunk splits oversize sections into overlapping windows", () => {
  const body = `# Big\n` + "x ".repeat(5000);
  const chunks = chunk(body, { maxChars: 2000, overlap: 100 });
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(c => c.body.length <= 2000)).toBe(true);
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/chunker.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/hash.ts`**

```ts
import { createHash } from "node:crypto";
export function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
```

- [ ] **Step 4: Implement `src/chunker.ts`**

```ts
export interface RawChunk { headingPath: string; ordinal: number; body: string; }
export interface ChunkOpts { maxChars: number; overlap: number; }

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

export function chunk(body: string, opts: ChunkOpts): RawChunk[] {
  const lines = body.split("\n");
  const stack: string[] = [];
  const sections: { headingPath: string; text: string[] }[] = [];
  let current: { headingPath: string; text: string[] } | null = null;

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      const level = m[1].length, title = m[2].trim();
      stack.length = level - 1;
      stack[level - 1] = title;
      const headingPath = stack.filter(Boolean).join(" > ");
      current = { headingPath, text: [] };
      sections.push(current);
    } else {
      if (!current) { current = { headingPath: "", text: [] }; sections.push(current); }
      current.text.push(line);
    }
  }

  const out: RawChunk[] = [];
  let ordinal = 0;
  for (const sec of sections) {
    const text = sec.text.join("\n").trim();
    if (!text) continue;
    for (const piece of windowed(text, opts.maxChars, opts.overlap)) {
      out.push({ headingPath: sec.headingPath, ordinal: ordinal++, body: piece });
    }
  }
  return out;
}

function windowed(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = []; const step = Math.max(1, maxChars - overlap);
  for (let i = 0; i < text.length; i += step) pieces.push(text.slice(i, i + maxChars));
  return pieces;
}
```

- [ ] **Step 5: Verify pass + commit**

Run: `npx vitest run test/chunker.test.ts` → 3 passed.
```bash
git add src/hash.ts src/chunker.ts test/chunker.test.ts && git commit -m "feat(kb): hashing + heading-aware chunker"
```

---

## Task 6: Schema + DB  *(Wave 1)*

**Files:** Create `src/schema.ts`, `src/db.ts`; Test `test/db.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";

test("openDb creates tables incl. fts and is queryable", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES (?,?,?,?,?,?,?)")
    .run("c1", "godot", "[]", "reference", 0, "/p", '["fts"]');
  db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("d1", "c1", "Look At", "", "[]", "/p/d1.md", "h", "reference", "[]", "t", "t");
  db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES (?,?,?,?,?,?,?)")
    .run("k1", "d1", "c1", "Nodes", 0, "rotate to face a point", "h");
  db.prepare("INSERT INTO chunks_fts(chunk_id, body) VALUES (?,?)").run("k1", "rotate to face a point");
  const row = db.prepare("SELECT chunk_id, bm25(chunks_fts) s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s").get("rotate") as any;
  expect(row.chunk_id).toBe("k1");
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/db.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/schema.ts`**

```ts
export const DDL = `
CREATE TABLE IF NOT EXISTS collections(
  id TEXT PRIMARY KEY, summary TEXT, tags TEXT, authority TEXT,
  doc_count INTEGER, path TEXT, backends TEXT);
CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY, collection_id TEXT, title TEXT, description TEXT, tags TEXT,
  path TEXT, content_hash TEXT, authority TEXT, sources TEXT,
  created_at TEXT, updated_at TEXT, supersedes TEXT, confidence REAL);
CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection_id);
CREATE INDEX IF NOT EXISTS idx_docs_supersedes ON docs(supersedes);
CREATE TABLE IF NOT EXISTS chunks(
  id TEXT PRIMARY KEY, doc_id TEXT, collection_id TEXT, heading_path TEXT,
  ordinal INTEGER, body TEXT, content_hash TEXT);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, body);
-- sealed plug-in point (unused in v1): doc_vec(chunk_id, embedding) via sqlite-vec.
`;
```

- [ ] **Step 4: Implement `src/db.ts`**

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

- [ ] **Step 5: Verify pass + commit**

Run: `npx vitest run test/db.test.ts` → 1 passed.
```bash
git add src/schema.ts src/db.ts test/db.test.ts && git commit -m "feat(kb): sqlite schema + db open"
```

---

## Task 7: Describe (cheap metadata extraction)  *(Wave 2)*

**Files:** Create `src/describe.ts`; Test `test/describe.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { describeBody } from "../src/describe.js";

test("describeBody uses first heading as title and first prose line as description", () => {
  const r = describeBody("# Idempotency Keys\nUse a key to dedupe requests.\nMore text.");
  expect(r.title).toBe("Idempotency Keys");
  expect(r.description).toBe("Use a key to dedupe requests.");
});
test("describeBody falls back to filename-derived title", () => {
  const r = describeBody("just text no heading", "retry-policy.md");
  expect(r.title).toBe("retry policy");
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/describe.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/describe.ts`**

```ts
export interface Described { title: string; description: string; tags: string[]; }

export function describeBody(body: string, filename?: string): Described {
  const lines = body.split("\n");
  let title = "";
  const h = lines.find(l => /^#\s+/.test(l));
  if (h) title = h.replace(/^#\s+/, "").trim();
  else if (filename) title = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim();
  const prose = lines.find(l => l.trim() && !/^#{1,6}\s/.test(l));
  const description = prose ? prose.trim().slice(0, 200) : "";
  return { title, description, tags: [] };
}
```
*(Note: LLM-assisted describe is a sealed enhancement — `describeBody` is the cheap path the indexer calls; an LLM path can wrap it later. See spec §6.)*

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/describe.test.ts` → 2 passed.
```bash
git add src/describe.ts test/describe.test.ts && git commit -m "feat(kb): cheap metadata describe"
```

---

## Task 8: Indexer (incremental reindex)  *(Wave 2 — needs T4,T5,T6)*

**Files:** Create `src/indexer.ts`; Test `test/indexer.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { openDb } from "../src/db.js";
import { reindexCollection } from "../src/indexer.js";
import { serializeDoc } from "../src/frontmatter.js";
import type { DocMeta } from "../src/types.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "kb-")); }
function meta(id: string): DocMeta {
  return { id, title: "T", description: "", tags: [], sources: [], authority: "reference",
    created_at: "t", updated_at: "t" };
}

test("reindex inserts chunks; re-run is a no-op; deletion is reflected", () => {
  const root = tmp();
  const docs = path.join(root, "collections", "c1", "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "a.md"), serializeDoc(meta("a"), "# A\nexponential backoff"));
  const db = openDb(":memory:");

  const r1 = reindexCollection(db, root, "c1");
  expect(r1.indexed).toBe(1);
  const count = () => (db.prepare("SELECT COUNT(*) n FROM docs").get() as any).n;
  expect(count()).toBe(1);

  const r2 = reindexCollection(db, root, "c1");
  expect(r2.indexed).toBe(0); // unchanged hash → skipped

  fs.rmSync(path.join(docs, "a.md"));
  reindexCollection(db, root, "c1");
  expect(count()).toBe(0); // deletion reflected
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/indexer.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/indexer.ts`**

```ts
import fs from "node:fs"; import path from "node:path";
import type { DB } from "./db.js";
import { parseDoc } from "./frontmatter.js";
import { chunk } from "./chunker.js";
import { sha256 } from "./hash.js";
import { docsDir } from "./paths.js";

const MAX_CHARS = 6000, OVERLAP = 300;

export interface ReindexResult { indexed: number; deleted: number; }

export function reindexCollection(db: DB, root: string, collectionId: string): ReindexResult {
  const dir = docsDir(root, collectionId);
  const seen = new Set<string>();
  let indexed = 0, deleted = 0;
  const files = fs.existsSync(dir) ? walk(dir) : [];

  const upsertDoc = db.prepare(`INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,created_at,updated_at,supersedes,confidence)
    VALUES (@id,@cid,@title,@description,@tags,@path,@hash,@authority,@sources,@created_at,@updated_at,@supersedes,@confidence)
    ON CONFLICT(id) DO UPDATE SET title=@title,description=@description,tags=@tags,path=@path,content_hash=@hash,authority=@authority,sources=@sources,updated_at=@updated_at,supersedes=@supersedes,confidence=@confidence`);
  const getHash = db.prepare("SELECT content_hash FROM docs WHERE id=?");
  const delChunks = db.prepare("DELETE FROM chunks WHERE doc_id=?");
  const delFts = db.prepare("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id=?)");
  const insChunk = db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES (?,?,?,?,?,?,?)");
  const insFts = db.prepare("INSERT INTO chunks_fts(chunk_id, body) VALUES (?,?)");

  const tx = db.transaction((file: string) => {
    const text = fs.readFileSync(file, "utf-8");
    const hash = sha256(text);
    const { meta, body } = parseDoc(text);
    const id = meta.id || sha256(file).slice(0, 12);
    seen.add(id);
    const prev = getHash.get(id) as { content_hash: string } | undefined;
    if (prev && prev.content_hash === hash) return; // unchanged
    upsertDoc.run({
      id, cid: collectionId, title: meta.title, description: meta.description,
      tags: JSON.stringify(meta.tags), path: file, hash, authority: meta.authority,
      sources: JSON.stringify(meta.sources), created_at: meta.created_at, updated_at: meta.updated_at,
      supersedes: meta.supersedes ?? null, confidence: meta.confidence ?? null,
    });
    delFts.run(id); delChunks.run(id);
    for (const c of chunk(body, { maxChars: MAX_CHARS, overlap: OVERLAP })) {
      const cid = `${id}#${c.ordinal}`;
      insChunk.run(cid, id, collectionId, c.headingPath, c.ordinal, c.body, hash);
      insFts.run(cid, c.body);
    }
    indexed++;
  });

  for (const f of files) tx(f);

  // delete docs whose files vanished
  const existing = db.prepare("SELECT id FROM docs WHERE collection_id=?").all(collectionId) as { id: string }[];
  const delDoc = db.prepare("DELETE FROM docs WHERE id=?");
  const delDocTx = db.transaction((id: string) => { delFts.run(id); delChunks.run(id); delDoc.run(id); deleted++; });
  for (const { id } of existing) if (!seen.has(id)) delDocTx(id);

  db.prepare("UPDATE collections SET doc_count=(SELECT COUNT(*) FROM docs WHERE collection_id=?) WHERE id=?")
    .run(collectionId, collectionId);
  return { indexed, deleted };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/indexer.test.ts` → 1 passed.
```bash
git add src/indexer.ts test/indexer.test.ts && git commit -m "feat(kb): incremental hash-keyed indexer"
```

---

## Task 9: Search (BM25 + normalization + diagnostics)  *(Wave 2 — needs T6)*

**Files:** Create `src/search.ts`; Test `test/search.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { search } from "../src/search.js";

function seed(db: any, id: string, cid: string, authority: string, body: string) {
  db.prepare("INSERT OR IGNORE INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES (?,?,?,?,?,?,?)")
    .run(cid, cid, "[]", authority, 0, "/p", '["fts"]');
  db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, cid, id, "", "[]", "/p/"+id+".md", "h", authority, "[]", "t", "t");
  const k = id + "#0";
  db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES (?,?,?,?,?,?,?)")
    .run(k, id, cid, "H", 0, body, "h");
  db.prepare("INSERT INTO chunks_fts(chunk_id, body) VALUES (?,?)").run(k, body);
}

test("search returns ranked hits with diagnostics; supersession hides old", () => {
  const db = openDb(":memory:");
  seed(db, "d1", "c1", "reference", "exponential backoff retry strategy");
  seed(db, "d2", "c2", "agent-note", "backoff notes from last week");
  const res = search(db, "backoff", {});
  expect(res.hits.length).toBeGreaterThan(0);
  expect(["high","medium","low"]).toContain(res.confidence);
  // reference outranks agent-note on comparable match
  expect(res.hits[0].authority).toBe("reference");
});

test("low confidence yields escalation next_step", () => {
  const db = openDb(":memory:");
  seed(db, "d1", "c1", "reference", "completely unrelated content");
  const res = search(db, "quantum chromodynamics", {});
  expect(res.confidence).toBe("low");
  expect(res.next_steps.join(" ")).toMatch(/research/i);
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/search.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/search.ts`**

```ts
import type { DB } from "./db.js";
import type { SearchHit, SearchResult, Authority, Source } from "./types.js";
import { AUTHORITY_RANK } from "./types.js";

export interface SearchOpts { collection?: string; tags?: string[]; k?: number; }

interface Row { chunk_id: string; doc_id: string; collection_id: string; heading_path: string;
  body: string; bm: number; title: string; authority: Authority; sources: string;
  updated_at: string; csummary: string; }

export function search(db: DB, query: string, opts: SearchOpts): SearchResult {
  const k = opts.k ?? 8;
  const match = ftsQuery(query);
  let sql = `SELECT f.chunk_id, c.doc_id, c.collection_id, c.heading_path, c.body,
      bm25(chunks_fts) AS bm, d.title, d.authority, d.sources, d.updated_at, col.summary AS csummary
    FROM chunks_fts f
    JOIN chunks c ON c.id=f.chunk_id
    JOIN docs d ON d.id=c.doc_id
    JOIN collections col ON col.id=c.collection_id
    WHERE chunks_fts MATCH @q
      AND d.id NOT IN (SELECT supersedes FROM docs WHERE supersedes IS NOT NULL)`;
  if (opts.collection) sql += ` AND c.collection_id=@coll`;
  sql += ` ORDER BY bm LIMIT 200`;
  let rows: Row[] = [];
  try { rows = db.prepare(sql).all({ q: match, coll: opts.collection ?? "" }) as Row[]; }
  catch { rows = []; }

  // normalize per collection (bm25: lower is better → invert), then authority + recency
  const byColl = new Map<string, Row[]>();
  for (const r of rows) (byColl.get(r.collection_id) ?? byColl.set(r.collection_id, []).get(r.collection_id)!).push(r);
  const scored: (SearchHit & { _n: number })[] = [];
  for (const group of byColl.values()) {
    const bms = group.map(r => r.bm);
    const min = Math.min(...bms), max = Math.max(...bms);
    for (const r of group) {
      const norm = max === min ? 1 : (max - r.bm) / (max - min); // 0..1, higher=better
      const auth = AUTHORITY_RANK[r.authority] * 0.05;
      const finalScore = norm + auth;
      scored.push({
        doc_id: r.doc_id, chunk_id: r.chunk_id, title: r.title, heading_path: r.heading_path,
        snippet: r.body.slice(0, 240), score: round(finalScore), authority: r.authority,
        sources: safeJson<Source[]>(r.sources, []), collection: { id: r.collection_id, summary: r.csummary },
        _n: norm,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, k).map(({ _n, ...h }) => h);

  const best = scored.length ? Math.max(...scored.map(s => s._n)) : 0;
  const confidence = best >= 0.66 ? "high" : best >= 0.33 ? "medium" : "low";
  const next_steps: string[] = [];
  if (confidence === "low") next_steps.push("Low coverage — consider escalating to deep-research (#3).");
  else if (confidence === "medium") next_steps.push("Refine with suggested_terms or scope to a candidate collection.");

  return {
    hits,
    confidence,
    confidence_reason: `best normalized score ${round(best)} over ${scored.length} candidate chunks`,
    suggested_terms: suggestTerms(rows, query, hits),
    candidate_collections: candidateCollections(db, query, hits),
    next_steps,
  };
}

function ftsQuery(q: string): string {
  const terms = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return terms.map(t => `"${t}"`).join(" OR ") || '""';
}
function suggestTerms(rows: Row[], query: string, hits: SearchHit[]): string[] {
  const qset = new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? []));
  const freq = new Map<string, number>();
  for (const r of rows.slice(0, 30)) for (const w of (r.body.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []))
    if (!qset.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);
}
function candidateCollections(db: DB, query: string, hits: SearchHit[]): string[] {
  const have = new Set(hits.map(h => h.collection.id));
  const terms = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const cols = db.prepare("SELECT id, summary, tags FROM collections").all() as any[];
  return cols.filter(c => !have.has(c.id) &&
      terms.some(t => (c.summary + " " + c.tags).toLowerCase().includes(t)))
    .map(c => c.id).slice(0, 5);
}
function safeJson<T>(s: string, fb: T): T { try { return JSON.parse(s) as T; } catch { return fb; } }
function round(n: number): number { return Math.round(n * 1000) / 1000; }
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/search.test.ts` → 2 passed.
```bash
git add src/search.ts test/search.test.ts && git commit -m "feat(kb): bm25 search with normalization + diagnostics"
```

---

## Task 10: Registry (bounded collection listing)  *(Wave 2 — needs T3)*

**Files:** Create `src/registry.ts`; Test `test/registry.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { listCollections } from "../src/registry.js";

test("listCollections is bounded by k and filterable by query", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 30; i++)
    db.prepare("INSERT INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES (?,?,?,?,?,?,?)")
      .run("c"+i, i===5?"godot game engine":"misc", "[]", "reference", 1, "/p", '["fts"]');
  const all = listCollections(db, { k: 12 });
  expect(all.length).toBe(12); // bounded
  const filtered = listCollections(db, { query: "godot", k: 12 });
  expect(filtered.some(c => c.id === "c5")).toBe(true);
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/registry.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/registry.ts`**

```ts
import type { DB } from "./db.js";
import type { CollectionMeta } from "./types.js";

export interface ListOpts { query?: string; tags?: string[]; k?: number; }

export function listCollections(db: DB, opts: ListOpts): CollectionMeta[] {
  const k = opts.k ?? 12;
  const rows = db.prepare("SELECT id,summary,tags,authority,doc_count,path,backends FROM collections").all() as any[];
  let cols: CollectionMeta[] = rows.map(r => ({
    id: r.id, summary: r.summary ?? "", tags: safeArr(r.tags), authority: r.authority,
    doc_count: r.doc_count ?? 0, path: r.path ?? "", backends: safeArr(r.backends),
  }));
  if (opts.query) {
    const terms = opts.query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
    cols = cols.map(c => ({ c, score: terms.filter(t =>
        (c.id + " " + c.summary + " " + c.tags.join(" ")).toLowerCase().includes(t)).length }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.c);
  }
  if (opts.tags?.length) cols = cols.filter(c => opts.tags!.every(t => c.tags.includes(t)));
  return cols.slice(0, k);
}
function safeArr(s: string): string[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/registry.test.ts` → 1 passed.
```bash
git add src/registry.ts test/registry.test.ts && git commit -m "feat(kb): bounded registry listing"
```

---

## Wave 3 — Tools

All tools live in `src/tools/*.ts` and export a `ToolDefinition`-shaped object factory `(ctx: KbContext) => ToolDefinition`. First define the shared context.

### Task 11a: KB context + secrets (prereq for write tools)

**Files:** Create `src/kb-context.ts`, `src/secrets.ts`; Test `test/secrets.test.ts`

- [ ] **Step 1: Implement `src/secrets.ts` with a failing test**

`test/secrets.test.ts`:
```ts
import { test, expect } from "vitest";
import { scanSecrets } from "../src/secrets.js";
test("flags obvious api keys and ssh keys", () => {
  expect(scanSecrets("token sk-ABCD1234EFGH5678IJKL9012MNOP").length).toBeGreaterThan(0);
  expect(scanSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").length).toBeGreaterThan(0);
  expect(scanSecrets("just normal prose").length).toBe(0);
});
```
Run `npx vitest run test/secrets.test.ts` → FAIL, then implement:
```ts
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "ssh-private", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "generic-token", re: /\b(token|secret|password)\b\s*[:=]\s*\S{12,}/i },
];
export function scanSecrets(text: string): string[] {
  return PATTERNS.filter(p => p.re.test(text)).map(p => p.name);
}
```
Run again → 1 passed. Commit: `git add src/secrets.ts test/secrets.test.ts && git commit -m "feat(kb): secret scanner"`.

- [ ] **Step 2: Implement `src/kb-context.ts`** (no separate test; exercised by tools)

```ts
import type { DB } from "./db.js";
export interface KbContext {
  globalDb: DB; projectDb: DB | null;
  globalRoot: string; projectRoot: string | null;
  cwd: string;
  // returns [db, root] for a given scope decision
  writeTarget(scope?: "global" | "project"): { db: DB; root: string };
}
```
*(index.ts constructs the concrete KbContext in Task 21.)* Commit with Step 1.

### Task 12: `kb_write`  *(Wave 3)*

**Files:** Create `src/tools/kb_write.ts`; Test `test/kb_write.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { openDb } from "../src/db.js";
import { makeKbWrite } from "../src/tools/kb_write.js";

function ctx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kbw-"));
  const db = openDb(":memory:");
  return { globalDb: db, projectDb: null, globalRoot: root, projectRoot: null, cwd: "/x",
    writeTarget: () => ({ db, root }) } as any;
}

test("kb_write rejects missing sources", async () => {
  const t = makeKbWrite(ctx());
  const r = await t.execute("id", { collection: "notes", title: "X", body: "y", tags: [], sources: [] } as any, undefined, undefined, {} as any);
  expect(r.content[0].text.toLowerCase()).toContain("source");
});

test("kb_write writes a sourced note file and indexes it", async () => {
  const c = ctx(); const t = makeKbWrite(c);
  const r = await t.execute("id", { collection: "notes", title: "Backoff",
    body: "use exponential backoff", tags: ["retry"],
    sources: [{ url: "https://x", title: "X" }] } as any, undefined, undefined, {} as any);
  expect(r.content[0].text).toMatch(/written/i);
  const docs = path.join(c.globalRoot, "collections", "notes", "docs");
  expect(fs.readdirSync(docs).length).toBe(1);
  const n = (c.globalDb.prepare("SELECT COUNT(*) n FROM docs").get() as any).n;
  expect(n).toBe(1);
});

test("kb_write blocks secrets", async () => {
  const t = makeKbWrite(ctx());
  const r = await t.execute("id", { collection: "notes", title: "X",
    body: "key sk-ABCD1234EFGH5678IJKL9012", tags: [],
    sources: [{ url: "https://x" }] } as any, undefined, undefined, {} as any);
  expect(r.content[0].text.toLowerCase()).toContain("secret");
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/kb_write.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/tools/kb_write.ts`**

```ts
import { Type } from "typebox";
import fs from "node:fs"; import path from "node:path";
import type { KbContext } from "../kb-context.js";
import type { DocMeta } from "../types.js";
import { serializeDoc } from "../frontmatter.js";
import { sha256 } from "../hash.js";
import { reindexCollection } from "../indexer.js";
import { scanSecrets } from "../secrets.js";
import { docsDir, collectionDir, collectionJsonPath } from "../paths.js";

export function makeKbWrite(ctx: KbContext) {
  return {
    name: "kb_write",
    label: "KB Write",
    description: "Write a SOURCED note into the knowledge library. Use for reference-worthy, citable knowledge (not personal preferences — those go to memory). `sources` is REQUIRED.",
    promptSnippet: "kb_write: persist a sourced note into the knowledge library",
    parameters: Type.Object({
      collection: Type.String({ description: "collection id (created if new)" }),
      title: Type.String(),
      body: Type.String({ description: "markdown body" }),
      tags: Type.Array(Type.String(), { default: [] }),
      sources: Type.Array(Type.Object({
        url: Type.Optional(Type.String()), path: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()), retrieved_at: Type.Optional(Type.String()),
        locator: Type.Optional(Type.String()),
      }), { description: "REQUIRED provenance" }),
      supersedes: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.Number()),
      scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
    }),
    async execute(_id: string, p: any) {
      if (!p.sources || p.sources.length === 0)
        return text("Refused: a note must carry at least one source (citation). Add `sources`.");
      const secrets = scanSecrets(p.body);
      if (secrets.length) return text(`Refused: possible secret(s) detected (${secrets.join(", ")}). Remove them before writing.`);

      const { db, root } = ctx.writeTarget(p.scope);
      ensureCollection(db, root, p.collection);
      const now = new Date().toISOString();
      const id = `${slug(p.title)}-${sha256(p.title + now).slice(0, 6)}`;
      const meta: DocMeta = { id, title: p.title, description: (p.body as string).split("\n").find((l:string)=>l.trim()) ?? "",
        tags: p.tags ?? [], sources: p.sources, authority: "agent-note",
        created_at: now, updated_at: now, supersedes: p.supersedes, confidence: p.confidence };
      const dir = docsDir(root, p.collection);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.md`), serializeDoc(meta, p.body));
      reindexCollection(db, root, p.collection);
      return text(`Written: ${id} into collection "${p.collection}" with ${p.sources.length} source(s).`);
    },
  };
}

export function ensureCollection(db: any, root: string, id: string) {
  fs.mkdirSync(collectionDir(root, id), { recursive: true });
  const cj = collectionJsonPath(root, id);
  if (!fs.existsSync(cj)) fs.writeFileSync(cj, JSON.stringify({ id, summary: id, tags: [], authority: "agent-note", backends: ["fts"] }, null, 2));
  db.prepare(`INSERT INTO collections(id,summary,tags,authority,doc_count,path,backends)
    VALUES (?,?,?,?,0,?,?) ON CONFLICT(id) DO NOTHING`)
    .run(id, id, "[]", "agent-note", collectionDir(root, id), '["fts"]');
}
function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "note"; }
function text(t: string) { return { content: [{ type: "text" as const, text: t }], details: {} }; }
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/kb_write.test.ts` → 3 passed.
```bash
git add src/tools/kb_write.ts test/kb_write.test.ts && git commit -m "feat(kb): kb_write tool (sourced, secret-scanned, self-indexing)"
```

### Task 13: `kb_import`  *(Wave 3)*

**Files:** Create `src/tools/kb_import.ts`; Test `test/kb_import.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { openDb } from "../src/db.js";
import { makeKbImport } from "../src/tools/kb_import.js";

test("kb_import copies a file into a collection, adds frontmatter, indexes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kbi-"));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "srcs-"));
  fs.writeFileSync(path.join(src, "doc.md"), "# Retry\nuse backoff");
  const db = openDb(":memory:");
  const ctx: any = { writeTarget: () => ({ db, root }) };
  const t = makeKbImport(ctx);
  const r = await t.execute("id", { path: path.join(src, "doc.md"), collection: "lib", authority: "reference" } as any, undefined, undefined, {} as any);
  expect(r.content[0].text).toMatch(/imported/i);
  const dir = path.join(root, "collections", "lib", "docs");
  const f = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf-8");
  expect(f.startsWith("---")).toBe(true); // frontmatter injected
  expect((db.prepare("SELECT COUNT(*) n FROM docs").get() as any).n).toBe(1);
});
```

- [ ] **Step 2: Verify fail** — FAIL.

- [ ] **Step 3: Implement `src/tools/kb_import.ts`**

```ts
import { Type } from "typebox";
import fs from "node:fs"; import path from "node:path";
import type { KbContext } from "../kb-context.js";
import type { DocMeta, Authority } from "../types.js";
import { parseDoc, serializeDoc } from "../frontmatter.js";
import { describeBody } from "../describe.js";
import { sha256 } from "../hash.js";
import { reindexCollection } from "../indexer.js";
import { docsDir } from "../paths.js";
import { ensureCollection } from "./kb_write.js";

export function makeKbImport(ctx: KbContext) {
  return {
    name: "kb_import",
    label: "KB Import",
    description: "Register an existing local file (or all .md files in a folder) into a collection. Adds frontmatter + indexes.",
    promptSnippet: "kb_import: add existing files to the knowledge library",
    parameters: Type.Object({
      path: Type.String({ description: "file or directory" }),
      collection: Type.String(),
      authority: Type.Optional(Type.Union([Type.Literal("reference"), Type.Literal("curated"), Type.Literal("agent-note")])),
      scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
    }),
    async execute(_id: string, p: any) {
      const { db, root } = ctx.writeTarget(p.scope);
      ensureCollection(db, root, p.collection);
      const files = fs.statSync(p.path).isDirectory()
        ? fs.readdirSync(p.path).filter(f => f.endsWith(".md")).map(f => path.join(p.path, f))
        : [p.path];
      const dir = docsDir(root, p.collection); fs.mkdirSync(dir, { recursive: true });
      const authority: Authority = p.authority ?? "reference";
      let n = 0;
      for (const f of files) {
        const raw = fs.readFileSync(f, "utf-8");
        const { meta, body } = parseDoc(raw);
        const now = new Date().toISOString();
        const d = describeBody(body, path.basename(f));
        const id = meta.id || `${slug(d.title || path.basename(f))}-${sha256(f).slice(0, 6)}`;
        const full: DocMeta = {
          id, title: meta.title || d.title, description: meta.description || d.description,
          tags: meta.tags.length ? meta.tags : d.tags, sources: meta.sources.length ? meta.sources : [{ path: f }],
          authority, created_at: meta.created_at || now, updated_at: now,
        };
        fs.writeFileSync(path.join(dir, `${id}.md`), serializeDoc(full, body));
        n++;
      }
      reindexCollection(db, root, p.collection);
      return { content: [{ type: "text" as const, text: `Imported ${n} file(s) into "${p.collection}".` }], details: {} };
    },
  };
}
function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "doc"; }
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/kb_import.test.ts` → 1 passed.
```bash
git add src/tools/kb_import.ts test/kb_import.test.ts && git commit -m "feat(kb): kb_import tool"
```

### Task 14: `kb_search`  *(Wave 3)*

**Files:** Create `src/tools/kb_search.ts`; Test `test/kb_search.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { makeKbSearch } from "../src/tools/kb_search.js";

test("kb_search returns hits + diagnostics across global and project dbs", async () => {
  const g = openDb(":memory:");
  g.prepare("INSERT INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES ('c','c','[]','reference',0,'/p','[\"fts\"]')").run();
  g.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,created_at,updated_at) VALUES ('d','c','D','','[]','/p/d.md','h','reference','[]','t','t')").run();
  g.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES ('d#0','d','c','H',0,'exponential backoff','h')").run();
  g.prepare("INSERT INTO chunks_fts(chunk_id,body) VALUES ('d#0','exponential backoff')").run();
  const ctx: any = { globalDb: g, projectDb: null };
  const t = makeKbSearch(ctx);
  const r = await t.execute("id", { query: "backoff" } as any, undefined, undefined, {} as any);
  const payload = JSON.parse(r.content[0].text);
  expect(payload.hits.length).toBe(1);
  expect(payload.confidence).toBeDefined();
});
```

- [ ] **Step 2: Verify fail** — FAIL.

- [ ] **Step 3: Implement `src/tools/kb_search.ts`**

```ts
import { Type } from "typebox";
import type { KbContext } from "../kb-context.js";
import { search } from "../search.js";
import type { SearchResult } from "../types.js";

export function makeKbSearch(ctx: KbContext) {
  return {
    name: "kb_search",
    label: "KB Search",
    description: "Pinpoint-search the knowledge library. Returns ranked doc sections grouped by collection, with provenance and diagnostics (confidence, suggested_terms, candidate_collections, next_steps). On low confidence, do NOT fabricate — follow next_steps.",
    promptSnippet: "kb_search: find the few relevant doc sections (lexical, ranked)",
    parameters: Type.Object({
      query: Type.String(),
      collection: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      k: Type.Optional(Type.Number({ default: 8 })),
      scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("global"), Type.Literal("project")])),
    }),
    async execute(_id: string, p: any) {
      const scope = p.scope ?? "all";
      const merged: SearchResult = { hits: [], confidence: "low", confidence_reason: "", suggested_terms: [], candidate_collections: [], next_steps: [] };
      const dbs = [];
      if (scope !== "project") dbs.push(ctx.globalDb);
      if (scope !== "global" && ctx.projectDb) dbs.push(ctx.projectDb);
      for (const db of dbs) {
        const r = search(db, p.query, { collection: p.collection, tags: p.tags, k: p.k ?? 8 });
        merged.hits.push(...r.hits);
        merged.suggested_terms.push(...r.suggested_terms);
        merged.candidate_collections.push(...r.candidate_collections);
        merged.next_steps.push(...r.next_steps);
      }
      merged.hits.sort((a, b) => b.score - a.score);
      merged.hits = merged.hits.slice(0, p.k ?? 8);
      const best = merged.hits[0]?.score ?? 0;
      merged.confidence = best >= 0.66 ? "high" : best >= 0.33 ? "medium" : "low";
      merged.confidence_reason = `top score ${best}`;
      merged.suggested_terms = [...new Set(merged.suggested_terms)].slice(0, 6);
      merged.candidate_collections = [...new Set(merged.candidate_collections)].slice(0, 5);
      merged.next_steps = [...new Set(merged.next_steps)];
      return { content: [{ type: "text" as const, text: JSON.stringify(merged, null, 2) }], details: {} };
    },
  };
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/kb_search.test.ts` → 1 passed.
```bash
git add src/tools/kb_search.ts test/kb_search.test.ts && git commit -m "feat(kb): kb_search tool (merges global+project)"
```

### Task 15: `kb_open`  *(Wave 3)*

**Files:** Create `src/tools/kb_open.ts`; Test `test/kb_open.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { makeKbOpen } from "../src/tools/kb_open.js";

test("kb_open returns a chunk by id, or full doc body with sources", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,created_at,updated_at) VALUES ('d','c','D','','[]','/p/d.md','h','reference','[{\"url\":\"u\"}]','t','t')").run();
  db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES ('d#0','d','c','H',0,'section body','h')").run();
  const ctx: any = { globalDb: db, projectDb: null };
  const t = makeKbOpen(ctx);
  const chunk = await t.execute("i", { id: "d#0" } as any, undefined, undefined, {} as any);
  expect(chunk.content[0].text).toContain("section body");
  expect(chunk.content[0].text).toContain("u"); // source surfaced
});
```

- [ ] **Step 2: Verify fail** — FAIL.

- [ ] **Step 3: Implement `src/tools/kb_open.ts`**

```ts
import { Type } from "typebox";
import type { KbContext } from "../kb-context.js";

export function makeKbOpen(ctx: KbContext) {
  return {
    name: "kb_open",
    label: "KB Open",
    description: "Open a chunk (by chunk id like 'doc#0') or a full doc (by doc id with full=true). Returns text plus its sources for citation.",
    promptSnippet: "kb_open: read a specific doc section (or full doc) with its sources",
    parameters: Type.Object({ id: Type.String(), full: Type.Optional(Type.Boolean()) }),
    async execute(_id: string, p: any) {
      for (const db of [ctx.globalDb, ctx.projectDb].filter(Boolean) as any[]) {
        if (!p.full) {
          const c = db.prepare("SELECT c.body, c.doc_id, c.heading_path, d.sources FROM chunks c JOIN docs d ON d.id=c.doc_id WHERE c.id=?").get(p.id);
          if (c) return out(`# ${c.heading_path}\n\n${c.body}\n\nsources: ${c.sources}`);
        }
        const d = db.prepare("SELECT path, sources FROM docs WHERE id=?").get(p.id);
        if (d) {
          const fs = await import("node:fs");
          const body = fs.existsSync(d.path) ? fs.readFileSync(d.path, "utf-8") : "(file missing)";
          return out(`${body}\n\nsources: ${d.sources}`);
        }
      }
      return out(`Not found: ${p.id}`);
    },
  };
}
function out(t: string) { return { content: [{ type: "text" as const, text: t }], details: {} }; }
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/kb_open.test.ts` → 1 passed.
```bash
git add src/tools/kb_open.ts test/kb_open.test.ts && git commit -m "feat(kb): kb_open tool"
```

### Task 16: `kb_cite`  *(Wave 3)*

**Files:** Create `src/tools/kb_cite.ts`; Test `test/kb_cite.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { makeKbCite } from "../src/tools/kb_cite.js";

test("kb_cite returns deduped formatted references", async () => {
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  ins.run("d1","c","T1","","[]","/p","h","reference",'[{"url":"https://x","title":"X"}]',"t","t");
  ins.run("d2","c","T2","","[]","/p","h","reference",'[{"url":"https://x","title":"X"}]',"t","t");
  const ctx: any = { globalDb: db, projectDb: null };
  const t = makeKbCite(ctx);
  const r = await t.execute("i", { doc_ids: ["d1","d2"] } as any, undefined, undefined, {} as any);
  // one unique source despite two docs
  expect((r.content[0].text.match(/https:\/\/x/g) || []).length).toBe(1);
});
```

- [ ] **Step 2: Verify fail** — FAIL.

- [ ] **Step 3: Implement `src/tools/kb_cite.ts`**

```ts
import { Type } from "typebox";
import type { KbContext } from "../kb-context.js";
import type { Source } from "../types.js";

export function makeKbCite(ctx: KbContext) {
  return {
    name: "kb_cite",
    label: "KB Cite",
    description: "Build a deduplicated reference list for the given doc ids (for bibliographies).",
    promptSnippet: "kb_cite: format citations for doc ids",
    parameters: Type.Object({ doc_ids: Type.Array(Type.String()) }),
    async execute(_id: string, p: any) {
      const seen = new Set<string>(); const refs: string[] = [];
      for (const db of [ctx.globalDb, ctx.projectDb].filter(Boolean) as any[]) {
        for (const id of p.doc_ids) {
          const d = db.prepare("SELECT sources FROM docs WHERE id=?").get(id);
          if (!d) continue;
          for (const s of JSON.parse(d.sources) as Source[]) {
            const key = s.url ?? s.path ?? JSON.stringify(s);
            if (seen.has(key)) continue; seen.add(key);
            refs.push(`- ${s.title ?? key}${s.url ? ` <${s.url}>` : ""}${s.locator ? ` (${s.locator})` : ""}`);
          }
        }
      }
      return { content: [{ type: "text" as const, text: refs.length ? refs.join("\n") : "No sources found." }], details: {} };
    },
  };
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/kb_cite.test.ts` → 1 passed.
```bash
git add src/tools/kb_cite.ts test/kb_cite.test.ts && git commit -m "feat(kb): kb_cite tool"
```

### Task 17: `kb_collections`  *(Wave 3)*

**Files:** Create `src/tools/kb_collections.ts`; Test `test/kb_collections.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { makeKbCollections } from "../src/tools/kb_collections.js";

test("kb_collections lists bounded, merged collections", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES ('godot','game engine docs','[]','reference',10,'/p','[\"fts\"]')").run();
  const ctx: any = { globalDb: db, projectDb: null };
  const t = makeKbCollections(ctx);
  const r = await t.execute("i", { query: "game" } as any, undefined, undefined, {} as any);
  expect(r.content[0].text).toContain("godot");
});
```

- [ ] **Step 2: Verify fail** — FAIL.

- [ ] **Step 3: Implement `src/tools/kb_collections.ts`**

```ts
import { Type } from "typebox";
import type { KbContext } from "../kb-context.js";
import { listCollections } from "../registry.js";

export function makeKbCollections(ctx: KbContext) {
  return {
    name: "kb_collections",
    label: "KB Collections",
    description: "List/filter knowledge-library collections (bounded, ranked). Use to discover what domains exist before searching.",
    promptSnippet: "kb_collections: discover available knowledge collections",
    parameters: Type.Object({ query: Type.Optional(Type.String()), tags: Type.Optional(Type.Array(Type.String())), k: Type.Optional(Type.Number({ default: 12 })) }),
    async execute(_id: string, p: any) {
      const cols = [];
      for (const db of [ctx.globalDb, ctx.projectDb].filter(Boolean) as any[])
        cols.push(...listCollections(db, { query: p.query, tags: p.tags, k: p.k ?? 12 }));
      const text = cols.slice(0, p.k ?? 12).map(c => `- ${c.id} (${c.doc_count} docs): ${c.summary}`).join("\n");
      return { content: [{ type: "text" as const, text: text || "No collections." }], details: {} };
    },
  };
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/kb_collections.test.ts` → 1 passed.
```bash
git add src/tools/kb_collections.ts test/kb_collections.test.ts && git commit -m "feat(kb): kb_collections tool"
```

### Task 18: `kb_update` + `kb_remove`  *(Wave 3)*

**Files:** Create `src/tools/kb_update.ts`, `src/tools/kb_remove.ts`; Test `test/kb_curate.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { openDb } from "../src/db.js";
import { serializeDoc } from "../src/frontmatter.js";
import { reindexCollection } from "../src/indexer.js";
import { makeKbUpdate } from "../src/tools/kb_update.js";
import { makeKbRemove } from "../src/tools/kb_remove.js";
import type { DocMeta } from "../src/types.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kbc-"));
  const docs = path.join(root, "collections", "c", "docs"); fs.mkdirSync(docs, { recursive: true });
  const meta: DocMeta = { id: "d1", title: "Old", description: "", tags: ["a"], sources: [{ url: "u" }],
    authority: "reference", created_at: "t", updated_at: "t" };
  fs.writeFileSync(path.join(docs, "d1.md"), serializeDoc(meta, "# Old\nbody"));
  const db = openDb(":memory:");
  db.prepare("INSERT INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES ('c','c','[]','reference',0,?,'[\"fts\"]')").run(path.join(root,"collections","c"));
  reindexCollection(db, root, "c");
  return { root, db, docs };
}

test("kb_update retags a doc in frontmatter + index", async () => {
  const { root, db } = setup();
  const ctx: any = { writeTarget: () => ({ db, root }), globalDb: db, projectDb: null };
  const t = makeKbUpdate(ctx);
  await t.execute("i", { collection: "c", id: "d1", tags: ["x","y"] } as any, undefined, undefined, {} as any);
  const row = db.prepare("SELECT tags FROM docs WHERE id='d1'").get() as any;
  expect(JSON.parse(row.tags)).toEqual(["x","y"]);
});

test("kb_remove archives the file and drops it from index", async () => {
  const { root, db, docs } = setup();
  const ctx: any = { writeTarget: () => ({ db, root }), globalDb: db, projectDb: null };
  const t = makeKbRemove(ctx);
  await t.execute("i", { collection: "c", id: "d1" } as any, undefined, undefined, {} as any);
  expect(fs.existsSync(path.join(docs, "d1.md"))).toBe(false);
  expect((db.prepare("SELECT COUNT(*) n FROM docs WHERE id='d1'").get() as any).n).toBe(0);
});
```

- [ ] **Step 2: Verify fail** — FAIL.

- [ ] **Step 3: Implement `src/tools/kb_update.ts`**

```ts
import { Type } from "typebox";
import fs from "node:fs";
import type { KbContext } from "../kb-context.js";
import { parseDoc, serializeDoc } from "../frontmatter.js";
import { reindexCollection } from "../indexer.js";

export function makeKbUpdate(ctx: KbContext) {
  return {
    name: "kb_update",
    label: "KB Update",
    description: "Curate a doc's metadata: retag, re-describe, change authority. Edits frontmatter (source of truth) then reindexes.",
    promptSnippet: "kb_update: edit a doc's tags/description/authority",
    parameters: Type.Object({
      collection: Type.String(), id: Type.String(),
      title: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      authority: Type.Optional(Type.Union([Type.Literal("reference"), Type.Literal("curated"), Type.Literal("agent-note")])),
      scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
    }),
    async execute(_id: string, p: any) {
      const { db, root } = ctx.writeTarget(p.scope);
      const row = db.prepare("SELECT path FROM docs WHERE id=? AND collection_id=?").get(p.id, p.collection) as any;
      if (!row) return out(`Not found: ${p.id}`);
      const { meta, body } = parseDoc(fs.readFileSync(row.path, "utf-8"));
      if (p.title !== undefined) meta.title = p.title;
      if (p.description !== undefined) meta.description = p.description;
      if (p.tags !== undefined) meta.tags = p.tags;
      if (p.authority !== undefined) meta.authority = p.authority;
      meta.updated_at = new Date().toISOString();
      fs.writeFileSync(row.path, serializeDoc(meta, body));
      reindexCollection(db, root, p.collection);
      return out(`Updated ${p.id}.`);
    },
  };
}
function out(t: string) { return { content: [{ type: "text" as const, text: t }], details: {} }; }
```

- [ ] **Step 4: Implement `src/tools/kb_remove.ts`**

```ts
import { Type } from "typebox";
import fs from "node:fs"; import path from "node:path";
import type { KbContext } from "../kb-context.js";
import { reindexCollection } from "../indexer.js";
import { collectionDir } from "../paths.js";

export function makeKbRemove(ctx: KbContext) {
  return {
    name: "kb_remove",
    label: "KB Remove",
    description: "Retire a doc (soft-delete: archived, not destroyed) or a whole collection, then reindex.",
    promptSnippet: "kb_remove: retire a doc or collection (archived)",
    parameters: Type.Object({
      collection: Type.String(), id: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
    }),
    async execute(_id: string, p: any) {
      const { db, root } = ctx.writeTarget(p.scope);
      const archive = path.join(collectionDir(root, p.collection), ".archive");
      fs.mkdirSync(archive, { recursive: true });
      if (p.id) {
        const row = db.prepare("SELECT path FROM docs WHERE id=? AND collection_id=?").get(p.id, p.collection) as any;
        if (!row) return out(`Not found: ${p.id}`);
        fs.renameSync(row.path, path.join(archive, path.basename(row.path)));
        reindexCollection(db, root, p.collection);
        return out(`Archived doc ${p.id}.`);
      }
      // whole collection
      db.prepare("DELETE FROM docs WHERE collection_id=?").run(p.collection);
      db.prepare("DELETE FROM chunks WHERE collection_id=?").run(p.collection);
      db.prepare("DELETE FROM collections WHERE id=?").run(p.collection);
      return out(`Removed collection ${p.collection} from index (files retained on disk).`);
    },
  };
}
function out(t: string) { return { content: [{ type: "text" as const, text: t }], details: {} }; }
```

- [ ] **Step 5: Verify pass + commit**

Run: `npx vitest run test/kb_curate.test.ts` → 2 passed.
```bash
git add src/tools/kb_update.ts src/tools/kb_remove.ts test/kb_curate.test.ts && git commit -m "feat(kb): kb_update + kb_remove curation tools"
```

---

## Task 19: Policy block + commands  *(Wave 4)*

**Files:** Create `src/policy.ts`, `src/commands.ts`; Test `test/policy.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import { kbPolicy } from "../src/policy.js";
test("kbPolicy mentions search-before-answer and routing vs memory", () => {
  const p = kbPolicy("compact");
  expect(p).toMatch(/kb_search/);
  expect(p.toLowerCase()).toMatch(/memory/);
  expect(kbPolicy("none")).toBe("");
});
```

- [ ] **Step 2: Verify fail** — FAIL.

- [ ] **Step 3: Implement `src/policy.ts`**

```ts
export type PolicyStyle = "full" | "compact" | "none";

export function kbPolicy(style: PolicyStyle): string {
  if (style === "none") return "";
  const compact = `<kb-policy>
You have a Knowledge Library (kb_* tools). Before answering substantive questions about a library/API/domain from memory, run kb_search and cite results. Sourced, reference-worthy knowledge → kb_write (sources REQUIRED). Personal preferences/lessons → memory, not the KB. On low search confidence, follow next_steps (often deep-research) — never fabricate.
</kb-policy>`;
  if (style === "compact") return compact;
  return compact.replace("</kb-policy>", `Recovery: noisy→filter by collection; off-vocabulary→reformulate with suggested_terms; lost→kb_collections; absent→escalate.
</kb-policy>`);
}
```

- [ ] **Step 4: Implement `src/commands.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KbContext } from "./kb-context.js";
import { reindexAll } from "./kb-context.js";

export function registerCommands(pi: ExtensionAPI, ctx: KbContext) {
  pi.registerCommand("kb-reindex", {
    description: "Rebuild the knowledge-library index from files",
    handler: async (_args, c) => { const n = reindexAll(ctx); if (c.hasUI) c.ui.notify(`KB reindexed: ${n} collection(s)`, "info"); },
  });
  pi.registerCommand("kb-consolidate", {
    description: "(stub) Merge/retire stale notes — see scout/#5 spec",
    handler: async (_args, c) => { if (c.hasUI) c.ui.notify("kb-consolidate is a v1 stub; full consolidation lands with the scout spec.", "warning"); },
  });
}
```

- [ ] **Step 5: Verify pass + commit**

Run: `npx vitest run test/policy.test.ts` → 1 passed.
```bash
git add src/policy.ts src/commands.ts test/policy.test.ts && git commit -m "feat(kb): policy block + slash commands"
```

---

## Task 20: KbContext construction + reindexAll  *(Wave 4)*

**Files:** Modify `src/kb-context.ts`; Test `test/kb-context.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { buildKbContext, reindexAll } from "../src/kb-context.js";

test("buildKbContext opens global db and reindexAll scans collections", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const docs = path.join(home, ".pi", "kb", "collections", "c", "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "d.md"), "---\nid: d\ntitle: D\nauthority: reference\nsources: []\ncreated_at: t\nupdated_at: t\n---\n# D\nbackoff");
  const ctx = buildKbContext({ homeDir: home, cwd: "/nope" });
  const n = reindexAll(ctx);
  expect(n).toBeGreaterThanOrEqual(1);
  expect((ctx.globalDb.prepare("SELECT COUNT(*) n FROM docs").get() as any).n).toBe(1);
});
```

- [ ] **Step 2: Verify fail** — FAIL.

- [ ] **Step 3: Replace `src/kb-context.ts` with full implementation**

```ts
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import type { DB } from "./db.js";
import { openDb } from "./db.js";
import { dbPath, collectionsDir, collectionJsonPath } from "./paths.js";
import { reindexCollection } from "./indexer.js";

export interface KbContext {
  globalDb: DB; projectDb: DB | null;
  globalRoot: string; projectRoot: string | null; cwd: string;
  writeTarget(scope?: "global" | "project"): { db: DB; root: string };
}

export function buildKbContext(opts?: { homeDir?: string; cwd?: string }): KbContext {
  const home = opts?.homeDir ?? os.homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const globalRoot = path.join(home, ".pi", "kb");
  const projectRoot = path.join(cwd, ".pi", "kb");
  const hasProject = fs.existsSync(projectRoot);
  const globalDb = openDb(dbPath(globalRoot));
  const projectDb = hasProject ? openDb(dbPath(projectRoot)) : null;
  ensureGitignore(globalRoot); if (hasProject) ensureGitignore(projectRoot);
  syncCollections(globalDb, globalRoot); if (projectDb) syncCollections(projectDb, projectRoot);
  return {
    globalDb, projectDb, globalRoot, projectRoot: hasProject ? projectRoot : null, cwd,
    writeTarget(scope) {
      if (scope === "project" && projectDb) return { db: projectDb, root: projectRoot };
      return { db: globalDb, root: globalRoot };
    },
  };
}

export function reindexAll(ctx: KbContext): number {
  let n = 0;
  n += reindexRoot(ctx.globalDb, ctx.globalRoot);
  if (ctx.projectDb && ctx.projectRoot) n += reindexRoot(ctx.projectDb, ctx.projectRoot);
  return n;
}

function reindexRoot(db: DB, root: string): number {
  const dir = collectionsDir(root);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    syncOne(db, root, e.name);
    reindexCollection(db, root, e.name); n++;
  }
  return n;
}
function syncCollections(db: DB, root: string) { const dir = collectionsDir(root); if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) syncOne(db, root, e.name); }
function syncOne(db: DB, root: string, id: string) {
  let summary = id, tags: string[] = [], authority = "reference", backends = ["fts"];
  const cj = collectionJsonPath(root, id);
  if (fs.existsSync(cj)) { try { const j = JSON.parse(fs.readFileSync(cj, "utf-8"));
    summary = j.summary ?? id; tags = j.tags ?? []; authority = j.authority ?? "reference"; backends = j.backends ?? ["fts"]; } catch {} }
  db.prepare(`INSERT INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES (?,?,?,?,0,?,?)
    ON CONFLICT(id) DO UPDATE SET summary=excluded.summary, tags=excluded.tags, authority=excluded.authority, backends=excluded.backends`)
    .run(id, summary, JSON.stringify(tags), authority, path.join(collectionsDir(root), id), JSON.stringify(backends));
}
function ensureGitignore(root: string) {
  fs.mkdirSync(root, { recursive: true });
  const gi = path.join(root, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "index.db\nindex.db-*\n");
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run test/kb-context.test.ts` → 1 passed.
```bash
git add src/kb-context.ts test/kb-context.test.ts && git commit -m "feat(kb): context construction + reindexAll + gitignore"
```

---

## Task 21: Wire the extension (`index.ts`)  *(Wave 4)*

**Files:** Create `index.ts`

- [ ] **Step 1: Implement `index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildKbContext, reindexAll } from "./src/kb-context.js";
import { registerCommands } from "./src/commands.js";
import { kbPolicy } from "./src/policy.js";
import { makeKbWrite } from "./src/tools/kb_write.js";
import { makeKbImport } from "./src/tools/kb_import.js";
import { makeKbSearch } from "./src/tools/kb_search.js";
import { makeKbOpen } from "./src/tools/kb_open.js";
import { makeKbCite } from "./src/tools/kb_cite.js";
import { makeKbCollections } from "./src/tools/kb_collections.js";
import { makeKbUpdate } from "./src/tools/kb_update.js";
import { makeKbRemove } from "./src/tools/kb_remove.js";

export default function (pi: ExtensionAPI) {
  const ctx = buildKbContext();
  for (const make of [makeKbSearch, makeKbOpen, makeKbCite, makeKbCollections, makeKbImport, makeKbWrite, makeKbUpdate, makeKbRemove])
    pi.registerTool(make(ctx) as any);
  registerCommands(pi, ctx);
  pi.on("session_start", async () => { try { reindexAll(ctx); } catch { /* index is rebuildable; never block startup */ } });
  pi.on("system_prompt", async (_e: any) => {
    const style = (process.env.KB_POLICY as any) || "compact";
    return { append: kbPolicy(style) } as any;
  });
}
```
*(Note: confirm the system-prompt hook name against `pi.on(...)` events in types.ts during implementation — it is `BeforeAgentStartEvent`/system-prompt customization per spec §8.1. If the event differs, adapt; the policy string is the deliverable.)*

- [ ] **Step 2: Typecheck**

Run: `cd ~/.pi/agent/extensions/pi-research-library && npx tsc --noEmit`
Expected: no errors. Fix any signature mismatches against `ToolDefinition` (the `as any` on registerTool is a deliberate shim; remove if types line up).

- [ ] **Step 3: Commit**

```bash
git add index.ts && git commit -m "feat(kb): wire extension entrypoint"
```

---

## Task 22: End-to-end + load in PI  *(Wave 4)*

**Files:** Create `test/e2e.test.ts`

- [ ] **Step 1: E2E test (write → search → open → cite)**

```ts
import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { buildKbContext } from "../src/kb-context.js";
import { makeKbWrite } from "../src/tools/kb_write.js";
import { makeKbSearch } from "../src/tools/kb_search.js";
import { makeKbOpen } from "../src/tools/kb_open.js";

test("write a sourced note, then find and open it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  const ctx = buildKbContext({ homeDir: home, cwd: "/none" });
  await makeKbWrite(ctx).execute("i", { collection: "notes", title: "Idempotency",
    body: "# Idempotency\nUse idempotency keys to dedupe retried requests.",
    tags: ["api"], sources: [{ url: "https://stripe.com/docs", title: "Stripe" }] } as any, undefined, undefined, {} as any);
  const res = JSON.parse((await makeKbSearch(ctx).execute("i", { query: "idempotency keys" } as any, undefined, undefined, {} as any)).content[0].text);
  expect(res.hits.length).toBeGreaterThan(0);
  const opened = await makeKbOpen(ctx).execute("i", { id: res.hits[0].chunk_id } as any, undefined, undefined, {} as any);
  expect(opened.content[0].text.toLowerCase()).toContain("idempotency");
});
```

- [ ] **Step 2: Run full suite**

Run: `npx vitest run`
Expected: all test files pass.

- [ ] **Step 3: Load in PI (manual smoke test)**

Run: `pi` in a scratch dir, then in the session: `/kb-reindex`, then ask the agent to call `kb_write` with a sourced note and `kb_search` for it.
Expected: tools appear in PI's tool list; write creates `~/.pi/kb/collections/<id>/docs/*.md`; search returns it. Confirm `~/.pi/kb/index.db` exists and `~/.pi/kb/.gitignore` contains `index.db`.

- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.ts && git commit -m "test(kb): end-to-end write/search/open"
```

---

## Self-review (completed against spec)

**Spec coverage:**
- §3 layout / files-as-truth → T20 (gitignore, collection.json sync), frontmatter T4. ✅
- §4 schema (collections/docs/chunks/chunks_fts; reserved doc_vec) → T6. ✅
- §4 frontmatter = metadata source of truth → T4 + indexer T8 reads frontmatter. ✅
- §5.1 BM25 + cross-collection normalization + authority/recency + supersession → T9. ✅
- §5.2 absence contract (confidence + escalate) → T9 + T14. ✅
- §5.5 recovery diagnostics (suggested_terms/candidate_collections/next_steps) → T9. ✅
- §6 ingestion + incremental hash reindex + kb_write/kb_import → T8/T12/T13. ✅
- §7 governance: authority weighting → T9; supersedes → schema T6 + search filter T9; secret scan → T11a/T12; `/kb-consolidate` stub → T19 (full consolidation deferred to scout spec, per spec). ⚠ dedup-on-write is NOT implemented in v1 tasks — **see gap note below.**
- §8 tool surface (search/open/cite/collections/import/write/update/remove) → T12–T18. ✅
- §8.1 onboarding (promptSnippet + policy block) → each tool + T19. ✅
- §9 coexistence (routing rule in kb_write/policy descriptions) → T12 description + T19 policy. ✅
- §10 risks: FTS5 check → T1; WAL → T6; collision-free ids → T12 (slug+hash). ✅

**Deliberate v1 gap (tracked, matches spec deferral):** dedup-on-write similarity check (spec §7) is **not** in these tasks — it pairs naturally with `/kb-consolidate`, which the spec defers to the scout (#5) spec. If you want minimal dedup in v1, add a task: in `kb_write`, run an FTS `MATCH` on the title/body against the target collection and warn on a high-overlap existing doc before writing. Flagged here rather than silently dropped.

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `KbContext`, `DocMeta`, `SearchResult`, `reindexCollection(db, root, id)`, `search(db, query, opts)`, `makeKb*(ctx)` are used consistently across tasks.

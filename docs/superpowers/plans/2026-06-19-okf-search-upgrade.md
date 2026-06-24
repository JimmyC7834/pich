# OKF Search Upgrade — Implementation Plan

> **SUPERSEDED (2026-06-20)** by `2026-06-20-semble-search-integration.md`. The FTS5 `kb_search` is retired in favor of semble (pi-semble extension). Do **not** implement this plan — these fuzzy/porter/snippet/facet upgrades to the SQLite search are obsolete now that search is hybrid semantic+lexical via semble.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> REQUIRED: Read `agent/extensions/pi-research-library/src/types.ts`, `src/frontmatter.ts`, `src/schema.ts`, `src/indexer.ts`, `src/search.ts`, `src/tools/kb_search.ts`, `test/search.test.ts`, `test/indexer.test.ts` before starting — the plan shows only diffs, not full files.
>
> REQUIRED: All test command: `npx vitest run agent/extensions/pi-research-library/test/` from repo root.

**Goal:** Add ES-style search features (type/resource fields, stemming, fuzzy expansion, multi-field search, snippets, tag/type filtering, facets) to the existing SQLite FTS5-based KB, keeping it zero-server, zero-dependency.

**Architecture:** Extend the existing FTS5 table schema (add title column, porter tokenizer), update indexer to feed title, rewrite search query to use multi-field MATCH + fuzzy expansion + snippet(), and add `type`/`resource` to DocMeta for OKF compliance. All changes within `agent/extensions/pi-research-library/src/`.

**Tech Stack:** SQLite FTS5 (built-in), vitest, TypeScript. Zero new npm packages.

---

## File Responsibility Map

| File | Role | Change |
|---|---|---|
| `src/types.ts` | `DocMeta` interface | Add `type` + `resource` fields |
| `src/frontmatter.ts` | YAML↔DocMeta parse/serialize | Map `type` + `resource` |
| `src/schema.ts` | DDL for FTS5 | Add `title` column, `porter` tokenizer |
| `src/indexer.ts` | Feed docs into FTS5 | Pass `title` to FTS5 insert; add `type`/`resource` to docs insert |
| `src/search.ts` | FTS5 query + ranking | Fuzzy expansion, multi-field query, snippet(), tag/type filter, facet helper |
| `test/search.test.ts` | Search tests | Add tests for new features |
| `test/indexer.test.ts` | Indexer tests | Verify title indexed, type/resource stored |

---

### Task 1: Add `type` and `resource` to DocMeta

**Files:**
- Modify: `agent/extensions/pi-research-library/src/types.ts`
- Modify: `agent/extensions/pi-research-library/src/frontmatter.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// In test/frontmatter.test.ts — add at bottom

import { describe, test, expect } from "vitest";
import { parseDoc, serializeDoc } from "../src/frontmatter.js";

describe("OKF type/resource", () => {

  test("parseDoc extracts type and resource from frontmatter", () => {
    const text = `---
type: BigQuery Table
title: Orders
description: One row per order.
resource: https://console.cloud.google.com/bigquery/orders
tags: [sales]
timestamp: 2026-01-01T00:00:00Z
---
some body
`;
    const { meta, body } = parseDoc(text);
    expect(meta.type).toBe("BigQuery Table");
    expect(meta.resource).toBe("https://console.cloud.google.com/bigquery/orders");
    expect(body.trim()).toBe("some body");
  });

  test("parseDoc defaults type/resource to empty string when missing", () => {
    const text = `---
title: No type
---
body
`;
    const { meta } = parseDoc(text);
    expect(meta.type).toBe("");
    expect(meta.resource).toBe("");
  });

  test("serializeDoc includes type and resource in YAML output", () => {
    const raw = `---
type: Metric
title: DAU
resource: https://example.com/dau
---
definition body
`;
    const { meta } = parseDoc(raw);
    const serialized = serializeDoc(meta, "definition body");
    expect(serialized).toContain("type: Metric");
    expect(serialized).toContain("resource: https://example.com/dau");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/extensions/pi-research-library/test/frontmatter.test.ts --reporter=verbose`

Expected: FAIL — `type` does not exist on type `DocMeta`

- [ ] **Step 3: Add `type` and `resource` to DocMeta**

In `src/types.ts`:

```typescript
// At line ~6, add type and resource to DocMeta
export interface DocMeta {
  id: string; title: string; description: string; tags: string[];
  sources: Source[]; authority: Authority;
  created_at: string; updated_at: string;
  supersedes?: string; confidence?: number;
  type?: string;        // OKF type field (e.g. "BigQuery Table", "Playbook")
  resource?: string;    // OKF resource URI
}
```

- [ ] **Step 4: Update frontmatter.ts to parse/serialize type and resource**

In `src/frontmatter.ts`, modify `parseDoc()`:

```typescript
// In parseDoc, after the existing fields (around line 22), add:
type: String(raw.type ?? ""),
resource: String(raw.resource ?? ""),
```

In `serializeDoc()`, add to the object (before the YAML.stringify call):

```typescript
// In serializeDoc, add:
if (meta.type) obj.type = meta.type;
if (meta.resource) obj.resource = meta.resource;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run agent/extensions/pi-research-library/test/frontmatter.test.ts --reporter=verbose`

Expected: PASS — all three new tests pass

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-research-library/src/types.ts agent/extensions/pi-research-library/src/frontmatter.ts agent/extensions/pi-research-library/test/frontmatter.test.ts
git commit -m "feat: add type and resource fields to DocMeta for OKF compat"
```

---

### Task 2: Upgrade FTS5 schema — multi-field + stemming

**Files:**
- Modify: `agent/extensions/pi-research-library/src/schema.ts`
- Modify: `agent/extensions/pi-research-library/src/indexer.ts`
- Modify: `agent/extensions/pi-research-library/test/indexer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// In test/indexer.test.ts — add after existing test

test("reindex stores title in FTS5 for multi-field search", () => {
  const root = tmp();
  const docsDir = path.join(root, "collections", "c1", "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const content = `---
id: a
title: Backoff Retry Strategy
---
exponential backoff with jitter
`;
  fs.writeFileSync(path.join(docsDir, "a.md"), content);
  const db = openDb(":memory:");
  reindexCollection(db, root, "c1");

  // FTS5 should match on title
  const row = db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'retry'").get() as any;
  expect(row).toBeTruthy();
  // body-only match still works
  const row2 = db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'jitter'").get() as any;
  expect(row2).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/extensions/pi-research-library/test/indexer.test.ts --reporter=verbose`

Expected: FAIL on the `MATCH 'retry'` query — title was never indexed into FTS5, so matching on a title-only word returns nothing. (If the schema hasn't changed yet, it might partially pass — verify it fails by checking that the FTS5 table currently has no `title` column.)

- [ ] **Step 3: Update schema.ts — add title column + porter tokenizer**

```typescript
// In schema.ts — replace the FTS5 CREATE statement (line 15)

// Before:
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, body);

// After:
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  body,
  tokenize='porter unicode61',
  content='chunks',
  content_rowid='rowid'
);
```

Wait — FTS5 external content tables require the content table to have matching columns. The current `chunks` table has `body` but no `title`. This approach needs either:

**Option A (simpler):** Use a standalone FTS5 table (no external content), keep inserting title + body directly.

```typescript
// Replace line 15 in schema.ts
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  title,
  body,
  tokenize='porter unicode61'
);
```

This is the correct choice. The existing `chunks` table remains the source of truth; FTS5 is just the search index. The existing indexer already inserts into both tables.

- [ ] **Step 4: Update indexer.ts — pass title to FTS5**

In `src/indexer.ts`, find the `insFts` prepared statement and the loop body:

```typescript
// Current (line 24-25):
const insFts = db.prepare("INSERT INTO chunks_fts(chunk_id, body) VALUES (?,?)");

// Change schema mismatch — need title parameter. The FTS5 table now has 3 columns.
// Update prepared statement:
const insFts = db.prepare("INSERT INTO chunks_fts(chunk_id, title, body) VALUES (?,?,?)");
```

And in the transaction loop, where `insFts.run(cid, c.body)` is called (line 44-45):

```typescript
// Before:
insFts.run(cid, c.body);

// After — include title from the parsed frontmatter (meta.title is available from parseDoc above):
insFts.run(cid, meta.title || "", c.body);
```

- [ ] **Step 5: Also store type and resource in the docs table (for filtering/facets later)**

The `docs` table already has a flexible schema. Type and resource don't need their own columns — they can go into a JSON blob or existing fields. But for clean SQL filtering, add them as columns.

Update `src/schema.ts` — expand `docs` table DDL:

```sql
-- Add type and resource columns (keep existing columns, just add these)
CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY, collection_id TEXT, title TEXT, description TEXT, tags TEXT,
  path TEXT, content_hash TEXT, authority TEXT, sources TEXT,
  type TEXT, resource TEXT,   -- NEW: OKF fields
  created_at TEXT, updated_at TEXT, supersedes TEXT, confidence REAL);
```

Update `src/indexer.ts` — in `upsertDoc` prepared statement parameter mapping (around line 35-39), add:

```typescript
// In the upsertDoc.run({...}) call, add:
type: meta.type || null,
resource: meta.resource || null,
```

And update the `upsertDoc` SQL to include the new columns:

```typescript
const upsertDoc = db.prepare(`INSERT INTO docs(
    id,collection_id,title,description,tags,path,content_hash,authority,sources,
    type,resource,created_at,updated_at,supersedes,confidence)
  VALUES (
    @id,@cid,@title,@description,@tags,@path,@hash,@authority,@sources,
    @type,@resource,@created_at,@updated_at,@supersedes,@confidence)
  ON CONFLICT(id) DO UPDATE SET
    title=@title,description=@description,tags=@tags,path=@path,content_hash=@hash,
    authority=@authority,sources=@sources,type=@type,resource=@resource,
    updated_at=@updated_at,supersedes=@supersedes,confidence=@confidence`);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run agent/extensions/pi-research-library/test/indexer.test.ts --reporter=verbose`

Expected: PASS — the new test finds 'retry' in title column

Then run full test suite to check for regressions:
Run: `npx vitest run agent/extensions/pi-research-library/test/ --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add agent/extensions/pi-research-library/src/schema.ts agent/extensions/pi-research-library/src/indexer.ts agent/extensions/pi-research-library/test/indexer.test.ts
git commit -m "feat: multi-field FTS5 with porter stemming and type/resource columns"
```

---

### Task 3: Fuzzy query expansion

**Files:**
- Create: `agent/extensions/pi-research-library/src/fuzzy.ts`
- Add to: `agent/extensions/pi-research-library/test/fuzzy.test.ts`

The fuzzy feature: when a user types "reciev", expand it to similar corpus words ("receive", "receipt") before running the FTS5 MATCH. Use Levenshtein distance ≤ 2 against a dictionary built once from the corpus.

- [ ] **Step 1: Write the failing test**

```typescript
// In test/fuzzy.test.ts — new file
import { test, expect } from "vitest";
import { buildDictionary, expandFuzzy } from "../src/fuzzy.js";

test("buildDictionary extracts unique words from text", () => {
  const dict = buildDictionary(["exponential backoff retry strategy", "retry with jitter"]);
  expect(dict.has("exponential")).toBe(true);
  expect(dict.has("retry")).toBe(true);
  expect(dict.has("jitter")).toBe(true);
  expect(dict.size).toBe(4); // exponential, backoff, retry, strategy, jitter
});

test("expandFuzzy returns exact match when it exists", () => {
  const dict = new Set(["backoff", "retry", "strategy"]);
  const expanded = expandFuzzy("retry", dict);
  expect(expanded).toContain("retry");
});

test("expandFuzzy catches typos with edit distance ≤ 2", () => {
  const dict = new Set(["receive", "receipt", "recent", "record"]);
  const expanded = expandFuzzy("reciev", dict); // reciev → receive (dist 1)
  expect(expanded).toContain("receive");
});

test("expandFuzzy returns empty for words with no near match", () => {
  const dict = new Set(["backoff", "retry"]);
  const expanded = expandFuzzy("quantum", dict);
  expect(expanded.length).toBe(0);
});

test("expandFuzzy respects max distance", () => {
  const dict = new Set(["receive"]);
  // "xyzabc" has distance 6 from "receive" — too far
  const expanded = expandFuzzy("xyzabc", dict, 2);
  expect(expanded.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/extensions/pi-research-library/test/fuzzy.test.ts --reporter=verbose`

Expected: FAIL — module not found

- [ ] **Step 3: Write the minimal implementation**

Create `src/fuzzy.ts`:

```typescript
/**
 * Fuzzy query expansion using Levenshtein distance.
 *
 * ponytail: O(n * m) per query term against full dictionary. For 5K docs this is
 * instant. If corpus grows 100x, switch to a BK-tree or symspell index.
 */

/** Build a set of unique lowercase words from a corpus of strings. */
export function buildDictionary(corpus: string[]): Set<string> {
  const words = new Set<string>();
  for (const text of corpus) {
    for (const w of text.toLowerCase().match(/\w{3,}/g) ?? []) {
      words.add(w);
    }
  }
  return words;
}

/** Find words in `dict` within Levenshtein `maxDist` of `term`. Returns up to 3. */
export function expandFuzzy(term: string, dict: Set<string>, maxDist = 2): string[] {
  const normalized = term.toLowerCase();
  if (dict.has(normalized)) return [normalized];

  const out: string[] = [];
  for (const word of dict) {
    if (Math.abs(word.length - normalized.length) > maxDist) continue;
    if (levenshtein(word, normalized) <= maxDist) {
      out.push(word);
      if (out.length >= 3) break;
    }
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,            // delete
        dp[j - 1] + 1,        // insert
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)  // substitute
      );
      prev = tmp;
    }
  }
  return dp[n];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run agent/extensions/pi-research-library/test/fuzzy.test.ts --reporter=verbose`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-research-library/src/fuzzy.ts agent/extensions/pi-research-library/test/fuzzy.test.ts
git commit -m "feat: add fuzzy query expansion via Levenshtein distance"
```

---

### Task 4: Rewrite search.ts — multi-field, fuzzy, snippet, filters, facets

**Files:**
- Modify: `agent/extensions/pi-research-library/src/search.ts`
- Modify: `agent/extensions/pi-research-library/test/search.test.ts`

This is the core change. The new search flow:
1. Parse query → tokenize + fuzzy expand each term
2. Build multi-field MATCH query: `title:term* OR body:term*`
3. Execute FTS5 MATCH with snippet()
4. Apply optional tag/type filters as SQL WHERE clauses
5. Score: BM25 normalised + authority boost (unchanged)
6. Provide facet helper function for `GROUP BY type / tags / collection`

- [ ] **Step 1: Write the failing test**

Add to `test/search.test.ts` (after existing tests):

```typescript
import { buildDictionary } from "../src/fuzzy.js";

// ── Multi-field search ──

test("search matches on title terms", () => {
  const db = openDb(":memory:");
  seed(db, "d1", "c1", "reference", "body content about backoff");
  // d1 title is "d1" from seed — not descriptive. Need a doc with a meaningful title.
  // Seed inserts title = id. So "d1" is the title. Let's seed directly with SQL for title control.
  db.prepare("INSERT OR IGNORE INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES ('c2','c2','[]','reference',0,'/p','[\"fts\"]')").run();
  db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,type,resource,created_at,updated_at) VALUES ('d2','c2','Retry Strategy Doc','','[]','/p/d2.md','h','reference','[]','','','t','t')").run();
  db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES ('d2#0','d2','c2','H',0,'exponential backoff with jitter','h')").run();
  db.prepare("INSERT INTO chunks_fts(chunk_id, title, body) VALUES ('d2#0','Retry Strategy Doc','exponential backoff with jitter')").run();

  const res = search(db, "retry", {});
  expect(res.hits.length).toBeGreaterThan(0);
  // Title match for "retry" should rank well
  expect(res.hits[0].doc_id).toBe("d2");
});

// ── Fuzzy expansion ──

test("search handles typos via fuzzy expansion", () => {
  const db = openDb(":memory:");
  seed(db, "d1", "c1", "reference", "exponential backoff retry strategy");
  const res = search(db, "backofff", {}); // typo: 3 f's
  expect(res.hits.length).toBeGreaterThan(0);
});

// ── Snippet ──

test("search returns highlighted snippet ", () => {
  const db = openDb(":memory:");
  seed(db, "d1", "c1", "reference", "the exponential backoff algorithm retries with jitter");
  const res = search(db, "backoff", {});
  expect(res.hits[0].snippet).toContain("backoff");
  // Should not be raw slice(0,240) — should include context
  expect(res.hits[0].snippet.length).toBeLessThan(240);
});

// ── Tag filter ──

test("search filters by tag", () => {
  const db = openDb(":memory:");
  // seed with a doc that has a tags JSON
  db.prepare("INSERT OR IGNORE INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES ('c1','c1','[]','reference',0,'/p','[\"fts\"]')").run();
  // docs with different tags
  for (const [id, tags] of [["d1", ["sales"]], ["d2", ["engineering"]]]) {
    db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,type,resource,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "c1", id, "", JSON.stringify(tags), "/p/" + id + ".md", "h", "reference", "[]", "", "", "t", "t");
    const k = id + "#0";
    db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES (?,?,?,?,?,?,?)")
      .run(k, id, "c1", "H", 0, "revenue data here", "h");
    db.prepare("INSERT INTO chunks_fts(chunk_id, title, body) VALUES (?,?,?)").run(k, "", "revenue data here");
  }
  const res = search(db, "revenue", { tags: ["sales"] });
  expect(res.hits.length).toBe(1);
  expect(res.hits[0].doc_id).toBe("d1");
});

// ── Type filter ──

test("search filters by type", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT OR IGNORE INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES ('c1','c1','[]','reference',0,'/p','[\"fts\"]')").run();
  for (const [id, type] of [["d1", "BigQuery Table"], ["d2", "Playbook"]]) {
    db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,type,resource,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "c1", id, "", "[]", "/p/" + id + ".md", "h", "reference", "[]", type, "", "t", "t");
    const k = id + "#0";
    db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES (?,?,?,?,?,?,?)")
      .run(k, id, "c1", "H", 0, "revenue data here", "h");
    db.prepare("INSERT INTO chunks_fts(chunk_id, title, body) VALUES (?,?,?)").run(k, "", "revenue data here");
  }
  const res = search(db, "revenue", { type: "Playbook" });
  expect(res.hits.length).toBe(1);
  expect(res.hits[0].doc_id).toBe("d2");
});

// ── Facets ──

test("getFacets returns counts by field", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT OR IGNORE INTO collections(id,summary,tags,authority,doc_count,path,backends) VALUES ('c1','c1','[]','reference',0,'/p','[\"fts\"]')").run();
  for (const id of ["d1", "d2", "d3"]) {
    db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,type,resource,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "c1", id, "", "[]", "/p/" + id + ".md", "h", "reference", "[]", "BigQuery Table", "", "t", "t");
    const k = id + "#0";
    db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES (?,?,?,?,?,?,?)")
      .run(k, id, "c1", "H", 0, "revenue data here", "h");
    db.prepare("INSERT INTO chunks_fts(chunk_id, title, body) VALUES (?,?,?)").run(k, "", "revenue data here");
  }
  // add one of a different type
  db.prepare("INSERT INTO docs(id,collection_id,title,description,tags,path,content_hash,authority,sources,type,resource,created_at,updated_at) VALUES ('d4','c1','d4','','[]','/p/d4.md','h','reference','[]','Playbook','','t','t')").run();
  db.prepare("INSERT INTO chunks(id,doc_id,collection_id,heading_path,ordinal,body,content_hash) VALUES ('d4#0','d4','c1','H',0,'revenue data here','h')").run();
  db.prepare("INSERT INTO chunks_fts(chunk_id, title, body) VALUES ('d4#0','','revenue data here')").run();

  const facets = getFacets(db, "revenue", "type");
  expect(facets["BigQuery Table"]).toBe(3);
  expect(facets["Playbook"]).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run agent/extensions/pi-research-library/test/search.test.ts --reporter=verbose`

Expected: Most new tests FAIL — search.ts doesn't support multi-field, fuzzy, tag/type filter, or facets yet. Old tests should still pass (or schema mismatch may break them temporarily; we'll verify after implementation).

- [ ] **Step 3: Update SearchOpts interface**

In `src/search.ts`, update the interface:

```typescript
export interface SearchOpts {
  collection?: string;
  tags?: string[];
  type?: string;       // NEW
  k?: number;
}
```

- [ ] **Step 4: Rewrite search.ts — the core function**

Replace the `search()` function and helpers in `src/search.ts`:

```typescript
import type { DB } from "./db.js";
import type { SearchHit, SearchResult, Authority, Source } from "./types.js";
import { AUTHORITY_RANK } from "./types.js";
import { buildDictionary, expandFuzzy } from "./fuzzy.js";

export interface SearchOpts {
  collection?: string;
  tags?: string[];
  type?: string;
  k?: number;
}

interface Row {
  doc_id: string; chunk_id: string; collection_id: string;
  title: string; heading_path: string; body: string;
  snippet: string; bm: number;
  authority: Authority; sources: string;
  updated_at: string; csummary: string;
}

let _dictionary: Set<string> | null = null;

export function getDictionary(db: DB): Set<string> {
  if (!_dictionary) {
    // ponytail: rebuilds per-process. For hot-reload scenarios, invalidate on reindex.
    const rows = db.prepare("SELECT body FROM chunks LIMIT 10000").all() as { body: string }[];
    _dictionary = buildDictionary(rows.map(r => r.body));
  }
  return _dictionary;
}

/** Invalidate dictionary cache (call after reindex). */
export function resetDictionary() { _dictionary = null; }

export function search(db: DB, query: string, opts: SearchOpts): SearchResult {
  const k = opts.k ?? 8;

  // 1. Fuzzy-expand query terms
  const dict = getDictionary(db);
  const terms = query.toLowerCase().match(/\w+/g) ?? [];
  const expanded = terms.flatMap(t => {
    const fuzzy = expandFuzzy(t, dict);
    return fuzzy.length > 0 ? fuzzy : [t];
  });

  // 2. Build multi-field MATCH query
  const match = expanded.map(t => `(title:${t}* OR body:${t}*)`).join(" AND ");

  // 3. Build filtered MATCH SQL
  let sql = `SELECT f.chunk_id, c.doc_id, c.collection_id, c.heading_path, c.body,
      snippet(chunks_fts, 2, '<b>', '</b>', '...', 40) AS snippet,
      bm25(chunks_fts, 0, 5, 1) AS bm,
      d.title, d.authority, d.sources, d.updated_at, col.summary AS csummary
    FROM chunks_fts f
    JOIN chunks c ON c.id=f.chunk_id
    JOIN docs d ON d.id=c.doc_id
    JOIN collections col ON col.id=c.collection_id
    WHERE chunks_fts MATCH @q
      AND d.id NOT IN (SELECT supersedes FROM docs WHERE supersedes IS NOT NULL)`;
  if (opts.collection) sql += ` AND c.collection_id=@coll`;
  if (opts.tags && opts.tags.length > 0) {
    const tagConditions = opts.tags.map((_, i) => `d.tags LIKE @tag${i}`).join(" OR ");
    sql += ` AND (${tagConditions})`;
  }
  if (opts.type) sql += ` AND d.type=@type`;
  sql += ` ORDER BY bm LIMIT 200`;

  // 4. Build params
  const params: Record<string, any> = { q: match, coll: opts.collection ?? "" };
  if (opts.tags) opts.tags.forEach((tag, i) => { params[`tag${i}`] = `%"${tag}"%`; });
  if (opts.type) params.type = opts.type;

  // 5. Execute
  let rows: Row[] = [];
  try { rows = db.prepare(sql).all(params) as Row[]; }
  catch { return emptyResult(query); }

  // 6. Score: per-collection BM25 norm + authority boost (unchanged logic)
  const byColl = new Map<string, Row[]>();
  for (const r of rows) (byColl.get(r.collection_id) ?? byColl.set(r.collection_id, []).get(r.collection_id)!).push(r);
  const scored: (SearchHit & { _n: number })[] = [];
  for (const group of byColl.values()) {
    const bms = group.map(r => r.bm);
    const min = Math.min(...bms), max = Math.max(...bms);
    for (const r of group) {
      const norm = max === min ? 1 : (max - r.bm) / (max - min);
      const auth = AUTHORITY_RANK[r.authority] * 0.05;
      scored.push({
        doc_id: r.doc_id, chunk_id: r.chunk_id, title: r.title, heading_path: r.heading_path,
        snippet: r.snippet || r.body.slice(0, 240),  // fallback if snippet() returns empty
        score: round(norm + auth), authority: r.authority,
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
    hits, confidence,
    confidence_reason: `best normalized score ${round(best)} over ${scored.length} candidate chunks`,
    suggested_terms: suggestTerms(rows, query, hits),
    candidate_collections: candidateCollections(db, query, hits),
    next_steps,
  };
}

// ── Facets ──

export interface FacetResult { value: string; count: number; }

/** Aggregate hit counts by a docs-table field (type, tags, collection_id, etc.). */
export function getFacets(db: DB, query: string, field: string, limit = 10): FacetResult[] {
  const match = (query.toLowerCase().match(/\w+/g) ?? []).map(t => `"${t}"`).join(" OR ") || '""';
  const sql = `
    SELECT d.${field} AS value, COUNT(DISTINCT d.id) AS count
    FROM chunks_fts f
    JOIN chunks c ON c.id=f.chunk_id
    JOIN docs d ON d.id=c.doc_id
    WHERE chunks_fts MATCH @q AND d.id NOT IN (SELECT supersedes FROM docs WHERE supersedes IS NOT NULL)
    GROUP BY d.${field}
    ORDER BY count DESC
    LIMIT @lim
  `;
  try {
    // ponytail: no parameterized column name in SQLite — validate field.
    const allowed = ["type", "collection_id", "authority"];
    if (!allowed.includes(field)) return [];
    return db.prepare(sql.replace(/\$\{field\}/g, field)).all({ q: match, lim: limit }) as FacetResult[];
  } catch { return []; }
}

// ── Helpers (unchanged but kept for reference) ──

function ftsQuery(q: string): string {
  const terms = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return terms.map(t => `"${t}"`).join(" OR ") || '""';
}

function emptyResult(q: string): SearchResult {
  return { hits: [], confidence: "low", confidence_reason: "query parse error", suggested_terms: [], candidate_collections: [], next_steps: ["Check query syntax"] };
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

> **Note:** The `getFacets` function uses string interpolation for the column name because SQLite doesn't support parameterized column names. The `allowed` whitelist prevents injection. This is a deliberate ponytail: YAGNI on a safer approach for 5K docs.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run agent/extensions/pi-research-library/test/search.test.ts --reporter=verbose`

Expected: ALL PASS (old tests + 6 new tests)

Run full suite:
Run: `npx vitest run agent/extensions/pi-research-library/test/ --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-research-library/src/search.ts agent/extensions/pi-research-library/test/search.test.ts
git commit -m "feat: multi-field search, fuzzy expansion, snippet, tag/type filter, facets"
```

---

### Task 5: Wire dictionary reset into reindex

**Files:**
- Modify: `agent/extensions/pi-research-library/src/indexer.ts`

When docs are reindexed, the fuzzy dictionary cache becomes stale. Reset it.

- [ ] **Step 1: Add dictionary reset call**

In `src/indexer.ts`, add the import and call at the end of `reindexCollection()`:

```typescript
// At top of file:
import { resetDictionary } from "./search.js";

// At end of reindexCollection function (after the doc_count update):
resetDictionary();
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `npx vitest run agent/extensions/pi-research-library/test/indexer.test.ts --reporter=verbose`
Expected: PASS

Run: `npx vitest run agent/extensions/pi-research-library/test/ --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add agent/extensions/pi-research-library/src/indexer.ts
git commit -m "fix: reset fuzzy dictionary cache on reindex"
```

---

### Task 6: Wire kb_search tool — expose facet and filter parameters

**Files:**
- Modify: `agent/extensions/pi-research-library/src/tools/kb_search.ts`

Currently the tool only passes `collection` and `tags` to search. Add `type` and `facet` parameters.

- [ ] **Step 1: Write the failing test**

```typescript
// In test/kb_search.test.ts — add
import { test, expect } from "vitest";
import { makeKbSearch } from "../src/tools/kb_search.js";
import { buildKbContext } from "../src/kb-context.js";
import { openDb } from "../src/db.js";
import { DDL } from "../src/schema.js";
import { serializeDoc } from "../src/frontmatter.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "kb-")); }

test("kb_search tool accepts type parameter", async () => {
  const root = tmp();
  const docsDir = path.join(root, "collections", "c1", "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "a.md"), `---
id: a
title: Orders
type: BigQuery Table
---
revenue data
`);
  fs.writeFileSync(path.join(docsDir, "b.md"), `---
id: b
title: Incident Response
type: Playbook
---
revenue data
`);

  const ctx = buildKbContext(root);
  // trigger reindex
  const { reindexAll } = await import("../src/indexer.js");
  // Actually wire through: the ctx needs to have been registered. Simplest: raw search test.
  // Just verify the tool definition accepts type param.
  const tool = makeKbSearch(ctx);
  expect(tool.parameters.type).toBeDefined();
  const def = tool.parameters as any;
  expect(def.properties?.type).toBeDefined();
});
```

- [ ] **Step 2: Update kb_search.ts**

```typescript
// In the parameters definition (around line 13), add:  
type: Type.Optional(Type.String({ description: "OKF type filter (e.g. BigQuery Table, Playbook)" })),
facet: Type.Optional(Type.String({ description: "Field to aggregate counts by (type, collection, authority)" })),
```

And in the execute function, pass `type` to search opts, and handle facet:

```typescript
// In the search call:
const r = search(db, p.query, {
  collection: p.collection,
  tags: p.tags,
  type: p.type,
  k: p.k ?? 8
});

// After merging hits, if p.facet is provided:
if (p.facet) {
  merged.facets = getFacets(db, p.query, p.facet);
}
```

Update `SearchResult` type to optionally include facets:

In `src/types.ts`:
```typescript
export interface SearchResult {
  hits: SearchHit[];
  confidence: "high" | "medium" | "low";
  confidence_reason: string;
  suggested_terms: string[];
  candidate_collections: string[];
  next_steps: string[];
  facets?: FacetResult[];   // NEW
}
export interface FacetResult { value: string; count: number; }  // NEW
```

- [ ] **Step 3: Run the test suite**

Run: `npx vitest run agent/extensions/pi-research-library/test/ --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add agent/extensions/pi-research-library/src/tools/kb_search.ts agent/extensions/pi-research-library/src/types.ts
git commit -m "feat: expose type filter and facet aggregation in kb_search tool"
```

---

## Summary of all changes

| File | What changed |
|---|---|
| `src/types.ts` | Added `type`, `resource` to `DocMeta`; added `FacetResult`, `facets` to `SearchResult` |
| `src/frontmatter.ts` | Parse/serialize `type` and `resource` from YAML |
| `src/schema.ts` | FTS5: added `title` column, `porter unicode61` tokenizer; docs: added `type TEXT, resource TEXT` |
| `src/indexer.ts` | Pass title to FTS5, store type/resource in docs, reset dictionary on reindex |
| `src/search.ts` | Multi-field MATCH, fuzzy expansion, snippet(), tag/type filters, getFacets() |
| `src/fuzzy.ts` | **New** — Levenshtein-based query expansion |
| `src/tools/kb_search.ts` | Added `type`, `facet` parameters |
| `test/frontmatter.test.ts` | Tests for type/resource parsing |
| `test/fuzzy.test.ts` | **New** — tests for buildDictionary, expandFuzzy |
| `test/search.test.ts` | Tests for multi-field, fuzzy, snippet, tag/type filter, facets |
| `test/indexer.test.ts` | Test for title indexed in FTS5 |

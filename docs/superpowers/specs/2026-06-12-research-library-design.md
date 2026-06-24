# Research Library (②b) — Design Spec

**Date:** 2026-06-12
**Subsystem:** ②b Research Library (see `docs/feature-groupings.md`)
**Base:** PI (`@earendil-works/pi-coding-agent` v0.74.2), extended in-place via an extension.
**Sibling (adopted, not built):** `pi-hermes-memory` handles agent memory / session
search / skill CRUD. This spec covers the **document corpus** Hermes does not.

---

## 1. Purpose & scope

**Vision (one line):** a private, AI-friendly *search engine* over a personalized,
unlimited corpus — the agent pinpoints the few relevant sections on demand instead of
carrying documentation in its context. The indexed lake; deep-research (#3) is the
river that feeds it; Hermes knows *you*, this knows *the documents*.

A scalable, self-growing **document library** the agent can pinpoint-query without
loading the corpus into context. Hosts imported reference docs (library/API/framework),
research papers/articles, and the agent's own sourced notes. Every retrievable unit
carries provenance so claims can be cited.

**In scope (v1):** storage model, indexing, retrieval (`kb_search`/`kb_open`),
ingestion, the self-growing write path (`kb_write`), citations/provenance, note
governance, and the agent tool surface.

**Out of scope (separate specs):** the **scout** exploration policy (#5), **deep
research** orchestration (#3), and **source acquisition** (fetching/crawling doc
sites & PDFs — this layer starts at "a file exists on disk").

**Deferred (acknowledged, designed-around, not built in v1):** embeddings/semantic
backend, doc versioning, upstream-freshness/TTL, federation promotion & cross-project
sharing, multimodal extraction, access control, registry-scale search.

---

## 2. Core principles

1. **Files are the source of truth; SQLite is a derived, rebuildable index.** Each doc
   file carries its metadata in **YAML frontmatter** (id, title, description, tags,
   sources, authority, timestamps, supersedes, confidence); `collection.json` holds
   collection metadata. The DB is built *from* frontmatter + body, so deleting it and
   rescanning is **lossless** — including citations and curation. (Frontmatter-as-truth
   is load-bearing: without it, gitignoring the `.db` would silently lose all `sources`
   and curation on rebuild.)
2. **Progressive disclosure.** The agent walks a *map*, never the corpus: registry →
   collection catalog → chunk → full doc.
3. **Collection is the scaling unit.** "Unlimited" is achieved by adding *depth*
   (more collections / sub-collections), never *width* in any single index.
4. **One flat ranked query by default.** Tier structure is for bounded context and
   result grouping — not mandatory per-lookup navigation. Walking tiers is reserved
   for *exploration*.
5. **No unsourced knowledge.** Agent-written notes must carry `sources`.

---

## 3. On-disk layout

Identical shape at two scopes; project layers on top of global at query time.

```
~/.pi/kb/                          # GLOBAL library root
  registry.json                    # collections only: id · summary · tags · counts · backends · path
  index.db                         # derived SQLite index (GITIGNORED, rebuildable)
  collections/
    godot-4.3/
      collection.json              # summary · tags · authority · backends enabled
      docs/                        # source files (.md / extracted .txt) — SOURCE OF TRUTH
        nodes/node2d.md
        ...
      .index/                      # OPTIONAL sealed point: vec.db (later). Graph artifacts owned by scout (#5) spec, not v1.
    distributed-systems-papers/
      collection.json
      docs/raft.md ...

<repo>/.pi/kb/                      # PROJECT library root — same shape, merged on top in-workspace
  .gitignore                       # contains: index.db
  registry.json
  index.db                         # gitignored
  collections/this-repo-notes/...
```

- **Committed:** `registry.json`, every `collection.json`, all `docs/**` (each with
  **YAML frontmatter** carrying its metadata — the source of truth for `sources`,
  `authority`, tags, etc.).
- **Gitignored:** `index.db` (+ future `vec.db`). Rebuilt incrementally on first use
  after clone via content hashes.

---

## 4. SQLite schema (derived index)

One `index.db` per library root. Tables:

```sql
collections(
  id TEXT PRIMARY KEY, summary TEXT, tags TEXT,          -- tags: JSON array
  authority TEXT,                                        -- reference | curated | agent-note
  doc_count INT, path TEXT, backends TEXT)               -- backends: JSON, e.g. ["fts"] or ["fts","vec"]

docs(
  id TEXT PRIMARY KEY,                                   -- collection-scoped, stable
  collection_id TEXT, title TEXT, description TEXT, tags TEXT,
  path TEXT, content_hash TEXT,
  authority TEXT,                                        -- inherited from collection unless overridden
  sources TEXT,                                          -- JSON: [{url|path,title,retrieved_at,locator}]
  created_at TEXT, updated_at TEXT,
  supersedes TEXT,                                       -- doc id this note replaces (nullable)
  confidence REAL)                                       -- agent-note self-rating (nullable)

chunks(
  id TEXT PRIMARY KEY, doc_id TEXT, collection_id TEXT,
  heading_path TEXT,                                     -- "Nodes > Node2D > look_at"
  ordinal INT, body TEXT, content_hash TEXT)

chunks_fts USING fts5(body, content=chunks, content_rowid=rowid)  -- BM25 search target

-- sealed plug-in point, created but unused in v1:
-- doc_vec(chunk_id, embedding)   via sqlite-vec, per-collection opt-in
-- (graph/relational exploration is NOT modelled here — owned by the scout #5 spec,
--  which runs graphify on-demand over a collection's docs/ folder; see §5.4)
```

**Chunking (load-bearing for "pinpoint"):** docs are split into `chunks` at Markdown
heading boundaries; sections longer than a soft cap (~1500 tokens) split further;
heading-less text (code/plain) uses fixed windows with small overlap. FTS indexes
**chunk bodies**, so a hit resolves to a *section*, and `kb_open` can return just that
section instead of a 100-page file.

**Metadata source of truth = frontmatter (not the DB).** Every `docs`/`chunks` row is
*derived* from a doc file's YAML frontmatter + body. `kb_import`'s describe-step
*writes* frontmatter back into the file; `kb_write` emits it; `kb_update` edits it then
reindexes. This is what makes the gitignored DB safely rebuildable (§2.1).

---

## 5. Retrieval

### 5.1 Search — one flat ranked query
`kb_search(query, { collection?, tags?, k=8, scope='all'|'global'|'project' })`:

1. Run FTS5 BM25 over `chunks_fts` in both global + project `index.db`, filtered by
   optional `collection`/`tags`.
2. **Cross-collection rank normalization:** scores normalized per collection (z-score
   or min-max) before merge, so a large collection can't swamp a small one;
   interleave by normalized score.
3. **Authority tiebreak/boost:** on near-equal scores, `reference > curated >
   agent-note`. The agent must not have its own past guess outrank an official doc.
4. **Recency/supersession:** rows whose id appears in another row's `supersedes` are
   demoted/hidden; ties break toward newer `updated_at`.
5. Return top-`k` **grouped by collection**, each hit: `{doc_id, chunk_id, title,
   heading_path, snippet, score, authority, sources, collection{id,summary}}`.
6. Attach **diagnostics** to the payload to guide refinement (see §5.5):
   `{confidence, confidence_reason, suggested_terms[], candidate_collections[],
   next_steps[]}`.

**Lexical-only mitigation:** an optional cheap LLM **query-expansion** step adds
synonyms/related terms before the FTS query (off by default; on for conceptual
queries). This is the v1 substitute for embeddings.

**Vec is a sealed plug-in point:** the retriever is structured as a `Retriever` with
per-collection `Backend`s (`FtsBackend` in v1; `VecBackend` sealed for later). When >1
backend answers, results fuse via **reciprocal-rank fusion**. Adding vec later =
implement `VecBackend` + flip a collection's `backends`; **no schema break** (the
`doc_vec` table is already reserved). Graph/relational retrieval is deliberately *not*
a library backend — it belongs to the scout (#5), see §5.4.

### 5.2 Absence contract (escalate, don't fabricate)
`kb_search` returns a top-level `confidence: high|medium|low` derived from best
normalized score + result spread, and `coverage` (did any collection plausibly own
this topic?). On `low`, the payload includes an explicit
`suggestion: "not well covered — consider deep-research"`. The tool description
instructs the agent: **low confidence → do not invent; escalate to research (#3).**

### 5.3 Open & cite
- `kb_open(doc_id | chunk_id, { full=false })` → chunk body by default, full doc on
  request. Returns `sources` alongside.
- `kb_cite(doc_id[])` → formatted reference list, de-duplicated by canonical
  `url|path`.

### 5.4 Exploration (tier-walk)
`kb_collections({ tags?, query?, k=12, page? })` lists/filters the merged registry
(collection summaries) — discovery via catalog + tags. This is the *only* path that
walks tiers deliberately.

**Graph-based exploration is out of scope for the library (owned by the scout, #5).**
Because docs are plain files, the scout spec can run **graphify on-demand over a
collection's `docs/` folder** to get relational exploration ("how do these connect",
god nodes, surprises) with **zero library-side coupling** — graphify's own incremental
cache/watch handle staleness. The library deliberately builds no graph and stores no
`edges`; this keeps v1 lexical-only and avoids graph-rebuild CRUD coupling on every
`kb_write`/`kb_update`/`kb_remove`.

**Always bounded (anti-context-pollution):** returns at most `k` ranked/paginated
collections — never the full registry. When a registry holds enough collections that
even a listing is large, collection summaries are themselves FTS-indexed so discovery
becomes a ranked query against `query` (the §11 registry-scale enhancement), keeping
the agent's context footprint flat regardless of total library size.

---

### 5.5 Recovery & refinement ladder (weak results)
The agent never blind-retries; `kb_search` diagnostics tell it which failure it faces
and what to do next. Failure modes map to distinct moves:

| Symptom | Move |
|---|---|
| Many irrelevant hits (noisy) | **Filter** — re-search scoped to a `candidate_collection` / `tags` |
| Sparse / off-vocabulary hits | **Reformulate** using `suggested_terms` (corpus-taught words, not blind synonyms) |
| Right area unknown | **Explore** — `kb_collections` / catalog to learn structure, then scoped search |
| Persistently low confidence | **Escalate** — corpus genuinely lacks it → deep-research (#3); never fabricate |

**Automatic first rung:** on a low-confidence result, `kb_search` runs *one*
query-expansion retry internally before returning, so the common case self-heals
without an extra agent round-trip. `next_steps[]` names the recommended manual move
when that isn't enough. Filtering (scope/collection/tags) and reformulation are both
first-class; diagnostics decide which the agent reaches for.

## 6. Ingestion & self-growth (one pipeline)

Adding a doc, importing a set, and the agent writing a note are the same operation:
**land a file → incrementally index it,** driven by content hashes.

1. **Land** — write/normalize source to `collections/<id>/docs/` as `.md`/`.txt`.
2. **Describe** — extract `title · description · tags`: cheap path from
   frontmatter/headings/filename; LLM-assisted summarizer only when metadata is thin
   (batched to bound cost on large imports). Notes supply their own.
3. **Chunk + index** — split into `chunks`, upsert `docs`/`chunks`/`chunks_fts`.
4. **Refresh** — update collection `doc_count`/`summary` + `registry.json`.

**Incremental + self-healing reindex:** `kb-reindex` scans `docs/`, diffs
`content_hash`, re-indexes only new/changed chunks, drops deleted. Same routine powers
rebuild-after-clone, manual import, and self-grow.

**Agent tools:**
- `kb_import(path, { collection })` — register an existing file/dir into a collection.
- `kb_write({ collection, title, body, tags, sources, supersedes?, confidence? })` —
  self-grow path; **`sources` required**. Writes file + indexes in one step.

---

## 7. Note governance (anti-self-pollution)

Borrow Hermes' proven approach:

- **Dedup-on-write:** `kb_write` runs an FTS near-duplicate check against the target
  collection. High overlap → return existing doc + offer `supersedes`/merge instead of
  creating a near-twin.
- **Supersession over deletion:** updated knowledge sets `supersedes` on the new note;
  old note is retained (audit) but demoted/hidden in search.
- **Authority weighting:** agent-notes never outrank `reference` docs on ties (§5.1),
  preventing citation laundering (an agent guess re-cited as fact).
- **Consolidation command:** `/kb-consolidate [collection]` spawns a child `pi.exec`
  (Hermes pattern) to merge related notes, retire stale ones, and tighten
  descriptions. Manual in v1; could be scheduled later (#7).

---

## 8. Agent-facing surface (summary)

| Tool | Purpose |
|---|---|
| `kb_search` | flat ranked pinpoint query (BM25, grouped, authority/recency-aware, absence-signalled) |
| `kb_open` | read a chunk (default) or full doc, with sources |
| `kb_cite` | formatted, de-duplicated references for doc ids |
| `kb_collections` | list/filter the merged registry (exploration) — **always bounded** (see §5.4) |
| `kb_import` | register an existing file/dir into a collection (creates the collection if new) |
| `kb_write` | self-grow: write a sourced note + index it |
| `kb_update` | curate metadata — retag, re-describe, change `authority`, on a doc **or** a collection |
| `kb_remove` | retire a doc or whole collection (soft-delete: index dropped, file archived not destroyed) |

Slash commands: `/kb-reindex`, `/kb-consolidate`.

**The registry is never auto-injected into context.** `SessionStart` runs only the
hash-gated reindex; collection summaries reach the agent solely through bounded
`kb_search` results and bounded `kb_collections` queries (§5.4).

### 8.1 How the agent learns to use the library
Progressive disclosure of the *instructions*, mirroring the data model — tiny always-on
policy, full detail on demand:

1. **`promptSnippet` per tool** (PI-native `ToolDefinition` field) — one line each in the
   "Available tools" section. Always present, near-zero cost; ensures the agent knows
   the tools exist.
2. **Compact `<kb-policy>` block at `SessionStart`** (Hermes pattern; configurable
   `full | compact | none`) — the *workflow*: when to consult the KB before answering
   from training knowledge, the routing rule vs Hermes (§9), and the recovery ladder
   (§5.5) in brief. Token-lean.
3. **`using-knowledge-library` skill** — the full workflow, examples, and recovery
   protocol, loaded **on demand** when the agent engages the KB (cf. Hermes'
   `/learn-memory-tool`). Heavy detail stays out of context until needed.

Tool descriptions convey *what*; the policy block + skill convey *when and in what
order* — the part that actually drives correct use.

Delivered as a single PI extension that `registerTool`s the above and runs an incremental
reindex on `SessionStart` (cheap; hash-gated).

---

## 9. Coexistence with pi-hermes-memory

The Research Library and Hermes are designed to run side by side as two PI extensions.

**Technically disjoint** (no collision on any shared surface):

| Surface | Hermes | Research Library |
|---|---|---|
| Storage | `~/.pi/agent/pi-hermes-memory/`, `…/projects-memory/<proj>/` | `~/.pi/kb/`, `<repo>/.pi/kb/` |
| SQLite | `sessions.db` | `index.db` |
| Tools | `memory_search`, `session_search`, memory/skill actions | `kb_search/open/cite/collections/import/write` |
| Commands | `/memory-*` | `/kb-*` |
| Config | `hermes-memory-config.json` | kb extension config |

PI's loader runs multiple extensions concurrently; both `registerTool` and hook
`SessionStart` independently.

**The real work is the *semantic* boundary** — once both load, the agent has two
search tools and two write paths. Routing must be explicit in tool descriptions:

- **Hermes** = short, *unsourced operational* memory: user prefs, lessons,
  corrections, conventions, tool quirks, session recall.
- **Research Library** = *documents + sourced knowledge*: imported reference docs,
  papers, and agent research notes carrying citations.
- **Routing rule (stated in `kb_write` / `memory` tool descriptions):** has an
  external source or is reference-worthy → `kb_write`; a working preference/lesson
  with no citation → Hermes memory.

**Complementarity (deferred):** Hermes entries may later reference KB doc ids, and
`kb_search`'s absence signal may suggest a memory check. v1 keeps them independent.

## 10. Implementation notes & risks

- **Feasibility check (do first in impl):** confirm the chosen Node SQLite binding
  supports **FTS5** on Windows (`node:sqlite` on Node 22+, or `better-sqlite3`). If
  FTS5 is unavailable, fall back to a bundled SQLite or reconsider. (sqlite-vec is
  deferred, so not gating v1.)
- **DB write concurrency:** WAL mode; if subagents run as separate processes they
  share the global `index.db` — serialize writes via a short-held lock
  (`proper-lockfile`, already a PI dep). Reindex is idempotent so retries are safe.
  **Doc-id/filename generation must be collision-free under parallel writes** (content
  hash or UUID), so concurrent `kb_write`s from multiple subagents/scouts can't clobber.
- **Describe-step cost:** LLM summarization only on thin-metadata docs, batched; large
  imports should prefer cheap-path metadata.
- **Token budget of results:** cap `k` and snippet length so `kb_search` payloads stay
  small.
- **Prompt-injection from doc content (security):** imported web pages / PDFs are
  *untrusted*. Retrieved doc text must be presented to the agent as **data, not
  instructions** (fenced/labelled in `kb_open`/`kb_search` output); the agent must not
  treat KB content as commands. Matters most for #3 web imports and #8 remote access.
- **Secret scanning on write (Hermes parity):** `kb_write` (and `kb_import`) run a
  secret scanner (API keys/tokens/SSH keys) before persisting — a note distilled from
  code could otherwise leak credentials into a committed, searchable file.

---

## 11. Open / deferred (tracked, not built)

Embeddings/vec (sealed point ready) · doc versioning · upstream freshness/TTL ·
federation promotion (project→global) & cross-project sharing · id-collision precedence
on global+project merge · multimodal/diagram extraction · per-doc access control
(matters once remote #8 exists) · registry-scale search when collections themselves
number in the thousands · **contradiction detection** (flag opposing claims, beyond
passive supersession) · **coverage / topic-synthesis retrieval** ("summarize everything
about T" via map-reduce, beyond top-`k`) · **citation/id stability** (doc-id stays
stable across rename/move/supersede so references never dangle) · **code/symbol &
multi-language tokenization** (FTS5 default tokenizer is weak on code symbols and
space-less languages like CJK — both are stated corpus types; needs symbol-aware /
per-language tokenizers or trigram) · **multi-root resolution** (which `.pi/kb` in
monorepos / nested repos / git worktrees) · **bad/binary ingest handling** (graceful
failure on corrupt PDF / non-text imports) · **cross-collection duplicate detection**
(same doc imported into two collections).

**Cross-spec dependency (not a gap here):** archiving fetched *source content* so
citations remain followable offline belongs to the #3 deep-research spec (source
acquisition), which writes into this library via `kb_write`.

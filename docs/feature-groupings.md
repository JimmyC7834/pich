# Custom AI Harness — Feature Groupings

**Date:** 2026-06-12
**Base:** `@earendil-works/pi-coding-agent` (PI) v0.74.2 — embedded as the agent engine.
**Status:** Decomposition agreed; per-subsystem design specs pending.

This document decomposes the harness into independent subsystems so each can be
specified, planned, and built in its own cycle. It is the map, not a spec.

---

## What PI already provides (the base)

We do **not** rebuild these; we wrap and extend them.

| PI surface | What it gives us |
|---|---|
| Skills system (`skills.js`) + package-manager | Skill discovery, install, load |
| Extensions (loader / runner / wrapper) | The hook points for our additions |
| Tools (bash, edit, write, read, find, grep, ls) | Coding + filesystem actions |
| RPC mode (JSONL over stdio) | Programmatic drive — remote + scheduled invocation |
| Print mode (one-shot, non-interactive) | Headless runs for cron |
| SDK (embeddable) | The harness wraps this |
| Sessions + compaction + event-bus | Per-conversation state and signals |
| Model registry / providers | Multi-provider (currently deepseek-v4-pro) |

**We build on top:** orchestration, deep research, citations, self-growing KB +
scout, chat UI, scheduler, remote/social bridge, and human-in-the-loop UX.

---

## Subsystems

### ① Core harness & agent orchestration  *(foundation)*
The spine. Embeds PI's SDK and decides who runs, with which skills, and how
results flow back.
- **#2 Main vs subagent management** — spawn, supervise, route work, collect
  results, manage context budgets between a coordinator and workers.
- **#1 Skill library management + presets** — curate the skill lib, define named
  presets (bundles of skills/config), attach a preset to an agent or subagent.

Everything else depends on this. Build first.

### ② Knowledge & research engine
One coherent loop: explore → synthesize → persist. **Split into two subsystems:**

**②a Agent Memory — ADOPT `pi-hermes-memory` (don't build).**
Covers self-notes/lessons (`MEMORY.md`), user profile (`USER.md`), session
search, and skill CRUD. Markdown source-of-truth + SQLite/FTS5 mirror, global +
project scope, auto-consolidation on overflow, secret-scan on write. This also
absorbs most of **#1's skill storage** (CRUD + similarity guards + project skill
discovery), leaving skill *presets/bundling* as the new work.

**②b Research Library — BUILD (current design focus).**
The document corpus Hermes does NOT cover:
- **#5 Self-growing KB + scout** — collections grow as the agent writes sourced
  notes (`kb_write`); scout explores via catalog, and (in the #5 spec) runs
  **graphify on-demand** over a collection's `docs/` folder for relational
  exploration. The library itself builds no graph.
- **#3 Deep research** — multi-step orchestration over web/docs/code (consumes ②b).
- **#4 Citing** — every doc/note carries provenance (`sources`); notes can't enter
  unsourced.

### ③ Interaction surfaces
Different ways to *invoke* the harness.
- **#6 Copilot-style chat + coding** — interactive, conversational coding UI.
- **#7 Schedule / cron AI usage** — timed, headless runs (via print/RPC mode).
- **#8 Remote interface / social bridge** — drive and receive output through a
  remote channel (e.g. social media).

### ④ Harness UX / human-in-the-loop  *(cross-cutting)*
Shared service every subsystem emits into — not a standalone slice.
- Ping the user on completion (push notification).
- Ask the user a question mid-run and block on the answer.
- Surface live status / progress.

---

## Build order

```
①  Core harness & orchestration   (the spine — build first)
│
├─ ②  Knowledge & research engine
└─ ③  Interaction surfaces
        ④  UX / human-in-the-loop  (built incrementally alongside ① → ③)
```

Each subsystem gets its own `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
spec → implementation plan → build cycle.

---

## Decisions log

- **Integration model:** Extend PI in-place via extensions/skills (not a separate
  orchestrator, not SDK-embed). PI's extension API gives session control
  (`newSession`/`fork`/`sendUserMessage`/`waitForIdle`), `registerTool`, lifecycle
  hooks, and UI primitives. Where true isolation/parallelism is needed, a
  registered tool can still shell out to separate `pi` RPC processes.
- **Subagent runtime:** OPEN — external `pi` RPC processes vs in-process child
  sessions vs hybrid. To resolve in the ① spec.
- **②a Agent Memory:** Adopt `pi-hermes-memory` as-is.
- **②b Research Library (current focus) — design decisions:**
  - Files = source of truth; **SQLite = derived, rebuildable index** over them.
  - **Collection** is the scaling unit (depth, not width → "unlimited").
  - On-disk: `registry` (collections only) → per-collection `catalog` + `docs/` +
    optional `.index/` (graph, vec).
  - **Search = one flat ranked query** (FTS5 BM25, optional vec) across all
    collections, grouped by collection; tier-walk reserved for *exploration*.
  - One DB per library root (global `~/.pi/kb`, project `<repo>/.pi/kb`),
    UNION-ed at query. **`.db` gitignored, rebuilt from files via content hashes.**
  - Ingestion = land file + incremental hash-keyed index; `kb_write` self-grow path
    reuses it; **notes require `sources`** (citations as provenance).
  - **Graphify deferred to the scout (#5) spec, not the library.** Evaluated as a
    KB replacement → it's an exploration/relational layer, not a curated-library +
    lexical-lookup + provenance substrate. Library v1 is lexical-only; scout runs
    graphify on-demand over collection `docs/` folders (free integration via
    files-as-truth, zero CRUD coupling). No `GraphBackend`/`edges` in v1.
  - **Metadata source of truth = YAML frontmatter in each doc file** (not the DB);
    DB is derived → gitignored `.db` rebuilds losslessly (incl. `sources`).
  - **Load-bearing gaps to resolve in spec:** (a) chunk/section-level indexing for
    real "pinpoint"; (b) embeddings feasibility gate; (c) note governance — reuse
    Hermes' auto-consolidation pattern.
  - Deferred (acknowledge in spec): versioning, upstream freshness, federation
    edges (id collisions/promotion/cross-project), absence/low-confidence contract,
    extraction quality + multimodal, access control, registry scaling.

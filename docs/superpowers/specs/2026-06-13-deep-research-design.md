# Deep Research (②b · #3) — Design Spec

**Date:** 2026-06-13
**Subsystem:** ②b Knowledge & research engine — **#3 Deep Research** (see `docs/feature-groupings.md`)
**Base:** PI (`@earendil-works/pi-coding-agent` v0.74.2), extended in-place via an extension (`pi-deep-research`).
**Consumes:** ②b Research Library (`kb_import`/`kb_write`/`kb_search`/`kb_cite`, already built).
**Adopts (already installed PI packages, not built here):** `pi-web-access` (web search + fetch + clean extraction + PDF/GitHub), `pi-subagents` (worker runtime), `pi-askuserquestion` (human-in-the-loop). See §5/§6/§11.
**Siblings (not built here):** the Library itself (②b), the scout (#5), Hermes memory (②a).

> **Architecture revision (2026-06-13, post-Plan-1):** acquisition is **adopted from `pi-web-access`**, not built here. This extension owns only what `pi-web-access` lacks — the **bounded doc-site crawler**, **②b landing** (cited `reference` docs), and **run-store** — plus the conductor (Plan 2). Open-web **search is no longer deferred** (pi-web-access provides it). See the rescope note in the Plan 1 doc.

---

## 1. Purpose & scope

**Vision (one line):** a **library-feeding scout** — given a topic and a set of entry points,
it acquires sources, cleans them, and lands well-cited documents into the Research
Library so future `kb_search` hits are rich. The polished report is a byproduct; the
durable output is **sourced docs in ②b**.

Deep Research is the **conductor** that drives one research run: decompose a topic over
user-supplied sources → investigate each part in an isolated worker → land cleaned
`reference` docs + one synthesized `agent-note` → cite. It owns **source acquisition**
(the layer ②b explicitly excludes: "starts at — a file exists on disk"; #3 is what puts
the file on disk).

**In scope:**
- **Plan 1 (built):** ②b **landing** (`dr_land` — persist clean Markdown as a cited `reference` doc), **bounded doc-site crawler** (`dr_crawl`), **run-store**.
- **Plan 2 (to build):** the **conductor** — run lifecycle / state machine (SCOPE → PLAN → DISPATCH → ASSESS → SYNTHESIZE → CITE → LAND); **context-isolated workers** that call `pi-web-access` to acquire and `dr_land` to persist; one synthesized `agent-note` (`kb_write`) + citation pass (`kb_cite`).
- **Provisional lifecycle:** all outputs tagged `deep-research` + `run-id`, reviewable/reversible, promoted later.
- **Per-role model tiering** (cheap workers, strong synthesizer) as a first-class token lever.
- Hard budgets + kill switch; prompt-injection enforcement; run-store persistence; `headless` flag.

**Adopted (not built here):**
- **Acquisition = `pi-web-access`:** `web_search` (Exa/Perplexity/Gemini), `fetch_content` (URL→clean Markdown via Readability + Jina fallback), `code_search`, GitHub clone, PDF→Markdown. Replaces the per-source fetch/extract this spec originally planned. (Doc-site BFS **crawl** is the one gap → we keep `dr_crawl`.)
- **Worker runtime = `pi-subagents`:** isolated sub-sessions for the context-isolated workers (replaces the originally-sealed in-house `WorkerRunner`/①#2 dependency).
- **Human-in-the-loop = `pi-askuserquestion`:** the optional SCOPE clarifying question.

**Out of scope / deferred:**
- **`kb_move` / cross-collection promotion** — tracked ②b follow-up; runs land docs in their target collection up front.
- **Scheduled / cron trigger** (#7), **auto-escalation from `kb_search` low-confidence**, **agent-initiated mid-task** runs — v1 is **explicit command only**; `headless` flag pre-builds for these.
- Multimodal / PDF-diagram / OCR extraction; contradiction detection across sources; per-source access control.
- ~~Open-web search~~ — **now provided by `pi-web-access`** (no longer deferred). ~~Parallel `WorkerRunner`/①#2~~ — **now provided by `pi-subagents`**.

---

## 2. Core principles

1. **Raw text never enters the conductor.** Workers return *condensed findings + landed
   doc-ids only*. Fetched pages are offloaded into the library, not carried in context.
   This is the primary token-saver and the source of context isolation.
2. **Context isolation, not necessarily parallelism.** The quality win (per Anthropic's
   research: "spreading reasoning across independent context windows") comes from a
   **fresh isolated sub-context per worker** — which serial execution already provides.
   Parallelism is a *speed* optimization deferred to ①#2.
3. **The library is external memory.** Sources live in ②b and are pinpoint-queried
   later, not re-sent each turn.
4. **Provisional by default.** A run's output is tagged + run-scoped, reviewable and
   reversible as a set; nothing is treated as authoritative until curated.
5. **Acquired content is untrusted data, never instructions.** Deep Research is the
   harness's primary untrusted-content ingester; the injection boundary is enforced here.
6. **Hard backstops over LLM judgment.** "Done" is bounded by budgets, not only by a
   model's reflection.

---

## 3. Architecture & component boundaries

Delivered as one PI extension (`pi-deep-research`) registering `/research`,
`/research-status`, and a `research` tool.

| Component | One job | Depends on |
|---|---|---|
| **Conductor** | Owns run lifecycle/state machine; plans, dispatches, decides "done" | WorkerRunner, ②b |
| **WorkerRunner** (interface) | Run one worker to completion, isolated | PI SDK sessions (serial v1) |
| **Source Acquisition** | Fetch/crawl/PDF/repo → clean Markdown + provenance | web/fetch libs, filesystem |
| **Research worker** | Investigate ONE sub-question in its own context; land raw refs; return findings | Acquisition, `kb_import` |
| **Synthesizer** | Fuse worker findings → one `agent-note` | — |
| **Citation pass** | Verify each claim maps to a landed source; emit refs | ②b `kb_cite` |
| **Run store** | Persist run state/plan/findings; survive compaction/crash; resume | filesystem |
| **Model-role map** | Resolve each role (worker/summarize/compress/synthesis/citation) to a model | provider registry |

```
/research <topic> [--collection c] [--depth d] [--breadth n] [--max-sources m] [--headless]
  │
  Conductor (state machine, persisted to run-store)
  SCOPE → PLAN → DISPATCH(serial) → ASSESS → SYNTHESIZE → CITE → LAND
                     │
                     ▼
            WorkerRunner.run(subQuestion, sources, loadout) ── interface ──┐
              serial impl (v1): newSession → sendUserMessage → waitForIdle │
              parallel impl (later, ①#2): in-process pool / RPC ───────────┘
```

---

## 4. Run lifecycle (the state machine)

1. **SCOPE** — normalize the topic into a research brief; resolve entry points
   (URLs / crawl-root / PDFs / repo path). Optional **one** clarifying question —
   **skipped when `headless:true`** (cron-safe).
2. **PLAN** — decompose the brief into ≤ `breadth` sub-questions, each assigned a slice
   of the entry points. Pick/create the target collection (`reference` authority).
3. **DISPATCH (serial)** — for each sub-question, spawn an isolated worker (`pi-subagents`):
   - worker calls `pi-web-access` (`web_search`/`fetch_content`) to acquire + clean,
     then calls **`dr_land`** to persist each source as a `reference` doc (tagged
     `deep-research` + `run-id`);
   - worker **reflects** "enough?"; may do ≤ `depth` follow-up rounds (bounded);
   - returns `{ findings, landed_doc_ids[], gaps[] }` — **no raw text** to the conductor.
4. **ASSESS** — conductor reviews coverage/gaps; may trigger **one** gap-filling wave,
   then stops regardless (backstop).
5. **SYNTHESIZE** — `kb_write` one `agent-note` citing the landed `reference` ids
   (tagged `deep-research` + `run-id`).
6. **CITE** — separate pass: verify every claim in the note maps to a landed source;
   `kb_cite` the doc-ids into a de-duplicated reference list.
7. **LAND** — refresh the collection; return `{ report, note_id, source_ids[], coverage, gaps[] }`.

Each transition is persisted to the run-store, so a crashed/compacted run resumes.

---

## 5. Source acquisition (adopted from `pi-web-access`) + crawl + landing

Acquisition is **not built here** — it's adopted from the installed `pi-web-access`
extension, which already does it better than the original fetch-only plan:

```
Acquisition (pi-web-access — agent-mediated, called by Plan 2 workers):
  web_search(query, …)      → ranked results (Exa → Perplexity → Gemini fallback)   [un-defers open-web search]
  fetch_content(url|urls)   → clean Markdown (Readability + Jina fallback + RSC)
  code_search / GitHub clone / PDF→Markdown

Owned by THIS extension (the gap pi-web-access doesn't cover):
  dr_crawl(url, collection) → bounded same-origin BFS (max-pages, robots, depth) → land each page
  dr_land(markdown, source, collection) → persist clean Markdown as a CITED `reference` doc in ②b
  run-store                 → resumable run manifests
```

- **Integration is agent-mediated** (extensions can't call each other's tools from code):
  a Plan 2 worker (a `pi-subagents` sub-session) calls `pi-web-access` to acquire, then
  calls **`dr_land`** to persist. `dr_crawl` is the self-contained doc-site path.
- **Provenance on every landed doc** (source URL/path, retrieved-at, content-hash) so
  citations stay followable; `dr_land`/`dr_crawl` write `sources` into frontmatter.
- **HTML clean-extraction** (the load-bearing requirement) is handled by `pi-web-access`'s
  Readability path for single pages, and by `dr_crawl`'s own Readability+Turndown internals
  for crawled pages. Acquired text is **fenced data, never instructions**.
- **Landing is decoupled via files-as-truth:** `dr_land`/`dr_crawl` write frontmatter `.md`
  into the collection's `docs/`; ②b reindexes them (no cross-extension DB coupling). The
  doc lands as `authority: reference`, tagged `deep-research` + `run-id`.

---

## 6. Workers & context isolation (via `pi-subagents`)

The originally-sealed in-house `WorkerRunner` is replaced by the installed **`pi-subagents`**
package, which provides isolated sub-sessions. The conductor dispatches one sub-agent per
sub-question with this contract:

```
worker(subQuestion, budgets, models, loadout) →
  { findings: string; landedDocIds: string[]; gaps: string[] }   // NO raw text returned
```

- **Loadout (restricted):** the worker gets `pi-web-access` (acquire) + `dr_land`/`dr_crawl`
  (persist) + `read`/`grep` — **no destructive tools** (an injected page can't make it act).
- **Context isolation:** each worker runs in its own `pi-subagents` session; raw fetched
  page text stays inside the worker — only condensed findings + landed doc-ids return.
  This is the quality + token win (independent context windows).
- **Serial by default; parallel available.** Serial keeps the quality benefit and avoids
  concurrent-write contention. If parallelized later, concurrent `dr_land` writes to the
  shared collection need content-hash ids (already used) + a short write lock.
- Workers run a **restricted loadout**: acquisition + `read`/`grep` + `kb_import` only.
  No `edit`/`write`/`bash`/destructive tools — an injected page cannot make a worker act.

---

## 7. Library integration & provisional lifecycle

```
per worker:  acquire → clean-extract → write .md to collection/docs/ → kb_import
                       (authority: reference, tags: [deep-research, <run-id>])
conductor:   synthesize → kb_write (agent-note, sources = landed reference ids,
                       tags: [deep-research, <run-id>]) → citation pass (kb_cite)
later:       review deep-research-tagged docs → kb_update (re-tag / promote authority)
                       → curated    [kb_move across collections = deferred ②b follow-up]
```

- **Required ②b touch-up (minimal, in-scope):** `kb_write` hardcodes `authority:
  "agent-note"`, so raw sources must land via **`kb_import`** as `reference`. `kb_import`
  must set/inherit **`reference`** authority (today `ensureCollection` defaults a new
  collection to `agent-note`). This is the *only* ②b change v1 pulls in.
- **Reserve `kb_write` for the synthesis note** (correctly `agent-note`).
- **Provisional:** `deep-research` tag + `run-id` make a run's output reviewable and
  reversible as a unit; promotion is manual via `kb_update` (re-tag / raise authority).
- **`kb_move` deferred:** docs land directly in their target collection; cross-collection
  move is a tracked ②b follow-up (the user's "refine & move later" remainder).
- **Secret-scan on write** is inherited free (`kb_import`/`kb_write` already scan).

---

## 8. Controls, budgets & safety

**Agent/user surface**

| Surface | Purpose |
|---|---|
| `/research <topic>` | start a run (interactive) |
| `research(topic, { collection?, sources?, depth?, breadth?, max_sources?, headless? })` | programmatic / agent-initiated / future cron |
| `/research-status [run-id]` | inspect a run; resume a crashed one |
| run report (returned) | synthesis note + landed source-ids + coverage/gaps |

**Hard backstops (independent of LLM judgment):** `breadth` (≤ workers), `depth`
(≤ follow-up rounds/worker), `max_sources`, token ceiling, wall-clock; polite-crawl
(max-pages, same-origin, robots.txt). **Kill switch** cancels a run but keeps
already-landed docs.

**Safety**
- **Prompt injection (primary surface):** acquired content fenced as **data, not
  instructions**; workers run a **restricted loadout** (`pi-web-access` acquire + `dr_land`
  + `read`/`grep`, no destructive tools); the conductor never executes instructions found
  in fetched docs. (②b §10 *named* this; #3 *enforces* it.)
- **Headless-safe:** `headless:true` skips the SCOPE clarifying question (cron-ready).
- **Secret-scan:** inherited from ②b write path.

---

## 9. Token economics & model-role tiering

Deep research is inherently token-heavy (~15× a single chat — multiple contexts). This
design is **token-efficient, not cheap**; savings are architectural plus one explicit lever.

**Architectural savers** (built in): raw text offloaded to the library (not re-sent each
turn); workers return condensed findings only; HTML cleaned before any model sees it;
hard budgets cap worst-case spend; URL dedup.

**Explicit lever — per-role model map** (first-class):

```
RoleModelMap = {
  worker:    <cheap>,   // high-volume investigation
  summarize: <cheap>,   // condense fetched content
  compress:  <cheap>,   // squeeze findings for the conductor
  synthesis: <strong>,  // the one place quality matters most
  citation:  <strong>,  // claim → source verification
}
```

Configurable; **defaults to a single model** if unset (capability available without
forcing config). Optional **raw-only run mode** (skip synthesis) for pure-scout,
cheapest-possible enrichment — deferred flag, noted here.

*Note: serial vs parallel does **not** change token total — only wall-clock. Serial was
chosen for correctness/simplicity, not token savings.*

---

## 10. Persistence & testing

- **Run store:** `~/.pi/agent/pi-deep-research/runs/<run-id>.json` — brief, plan,
  per-worker status, landed ids, coverage/gaps. Survives compaction/crash; `/research-status`
  resumes.
- **Config:** `pi-deep-research-config.json` — default breadth/depth/budgets, crawl
  politeness, worker loadout name, `RoleModelMap`.
- **Offline-testable:** the crawler/landing take an injectable `fetch` (fixture HTML) so
  they test without live network; the conductor + worker contract are tested with a
  **fake worker** (stubbed `pi-web-access`/`pi-subagents`). Backstops and the state
  machine are pure-unit testable.

---

## 11. Coexistence & dependencies

**Adopted PI packages (already installed; see `agent/settings.json`):**
- **`pi-web-access`** — acquisition: `web_search`, `fetch_content`, `code_search`, GitHub
  clone, PDF→Markdown. The conductor's workers call these. (Note: search/some-fetch paths
  need provider API keys — Exa/Perplexity/Gemini; basic URL fetch + Readability is key-free.)
- **`pi-subagents`** — isolated worker sub-sessions (the worker runtime).
- **`pi-askuserquestion`** — the optional SCOPE clarifying question (HITL).

**Built/consumed:**
- **②b Research Library:** consumes `kb_write`/`kb_cite`; landing writes files directly
  (files-as-truth), so **no ②b change is required** (`kb_import` already defaults
  `reference`). `kb_move` remains a tracked ②b follow-up.
- **Plan 1 (this extension, built):** `dr_land`, `dr_crawl`, run-store, crawler.
- **#5 scout:** complementary — scout *explores* an existing collection (graphify on
  `docs/`); deep research *acquires* into it. Disjoint surfaces.
- **#7 cron:** `headless` flag pre-builds the non-interactive path; the trigger itself is deferred.

---

## 12. Open / deferred (tracked, not built)

`kb_move` / cross-collection promotion (→ ②b) · scheduled/cron trigger (#7) ·
auto-escalation from `kb_search` low-confidence · agent-initiated mid-task runs ·
raw-only cheap run mode · multimodal/PDF-diagram/OCR extraction · contradiction
detection across sources · per-source access control · chunk-level (sub-page) citation
locators · cross-run source dedup (same page already landed by a prior run).

*Resolved by adoption (no longer deferred):* open-web search → `pi-web-access`;
parallel worker runtime → `pi-subagents`.

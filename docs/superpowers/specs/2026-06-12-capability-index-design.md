# Capability Index (①/#1+#2) — Design Spec

**Date:** 2026-06-12
**Subsystem:** Skill-library management + presets (#1) and capability context-budget (#2),
see `docs/feature-groupings.md`.
**Base:** PI (`@earendil-works/pi-coding-agent` v0.74.2), extended in-place via an extension.
**Sibling specs:** Research Library (②b, `2026-06-12-research-library-design.md`) — same
files-as-truth + FTS5/BM25 engine, different corpus. This spec covers **capabilities**
(skills, tools, MCP calls); the Library covers **documents**.
**Adopted, not built:** an MCP transport package (`pi-mcp-adapter` / `pi-mcp`) supplies the
MCP client; this spec consumes its catalog. `pi-telemetry` is *referenced*, not installed.

---

## 1. Purpose & scope

**Vision (one line):** the same "tiny internet search" the Library gives documents, applied
to the agent's own *capabilities* — keep dozens-to-hundreds of skills, tools, and MCP calls
out of the baseline context, and let the agent pinpoint and **activate** the few it needs on
demand. A curated **loadout** stays always-on; the long tail is one `capability_search` away.

**The problem (measured).** PI injects **every** skill's name + description (≤1024 chars
each) + path into the system prompt on every turn (`skills.js → formatSkillsForPrompt`), and
MCP servers each dump dozens of full JSON-Schema tool blocks into context (Playwright MCP
≈13.7k tokens, Chrome DevTools ≈18k — gone before work starts). PI's only native knob for
skills is binary: fully visible (linear bloat) or `disable-model-invocation` (undiscoverable).
There is no middle tier. This spec builds the middle tier.

**In scope (the design; phased build — see §11):**
- A unified, derived **capability index** (FTS5/BM25) over three kinds: `skill`, `tool`, `mcp`.
- Retrieval: `capability_search` (light, ranked) — searches **all three sets by default, or one
  set via a `kind` filter** ("search skills for X" / "search MCP for Y").
- **Packaged skills:** a skill is a directory (`SKILL.md` + bundled scripts + tiny docs); we
  index **one capability per package** and activation hands back the package — internals are
  not separately indexed (a 500-skill library = 500 rows, not thousands).
- Activation: `capability_activate` dispatching to per-kind **Activators** (the G3 solution).
- **Loadouts** — named, switchable always-on working sets, with a frontend-ready CRUD API.
- Skill-authoring + dedup (`capability_add` for skills).
- **Promotion-on-use** (usage telemetry → auto-elevate hot capabilities into the active set).

**Out of scope (separate specs):** the MCP *transport* itself (adopted), deep-research (#3),
subagent orchestration (①'s spawn/route), the Library's document corpus (②b).

**Deferred (acknowledged, designed-around — see §11):** semantic/embedding ranking, LSP &
prompt-template kinds, cross-machine loadout sync, per-capability access control.

---

## 2. Core principles

1. **Files are the source of truth; SQLite is a derived, rebuildable index.** Skills are
   their `SKILL.md` files; loadouts are `loadouts.yaml`; the MCP catalog is the adapter's
   on-disk cache; native tools are read from PI at runtime. The `index.db` is built *from*
   these and is **gitignored** — deleting it and rebuilding is lossless.
2. **Find and activate are separate concerns.** One index + one search tool unify *discovery*
   across all kinds; a per-kind **Activator** isolates the three different *activation*
   mechanisms (§6). The agent sees two tools regardless of kind.
3. **Light search, heavy-on-activate.** Search results never carry a tool's full JSON Schema
   (the very weight we removed); the schema/payload materializes only at `capability_activate`.
4. **A loadout is the always-on budget.** Only loadout members pay baseline context cost; the
   rest are searchable. Loadouts are the unit of curation (#1) and the lever for #2.
5. **Fail open, never closed.** Every interception (the skills-block rewrite, the index
   harvest) degrades to "pass through unchanged / fall back to PI's default" on any parse
   miss — losing savings but never breaking the agent or hiding a capability.
6. **Three kinds, closed set.** `skill | tool | mcp`. New kinds (LSP, prompt-templates) are a
   new Activator + a new harvester — additive, no schema break.

---

## 3. On-disk layout

```
~/.pi/capabilities/                  # GLOBAL capability root
  loadouts.yaml                      # named loadouts + core set + active pointer default — SOURCE OF TRUTH
  index.db                           # derived FTS5 index (GITIGNORED, rebuildable)
  .archive/                          # soft-deleted authored skills (audit)

<repo>/.pi/capabilities/             # PROJECT root — same shape, merged on top at query time
  .gitignore                         # contains: index.db
  loadouts.yaml                      # project loadouts (layer over global)
  index.db                           # gitignored

# Skills themselves are NOT stored here — they live where PI already finds them
# (~/.claude or ~/.pi skills dirs, project .pi/skills). We index, we do not relocate.
# MCP catalog is read from the adapter's own cache (e.g. ~/.pi/agent/<adapter>/cache).
```

- **Committed:** `loadouts.yaml` (both scopes).
- **Gitignored:** `index.db`. Rebuilt on first use via content hashes + live sources.

---

## 4. Index schema (derived) — the heart

One `index.db` per root. The index is **kind-agnostic**; per-kind differences live only in
how `searchText` columns are filled (§5) and how records activate (§6).

```sql
capability(
  id            TEXT PRIMARY KEY,   -- stable, namespaced: "skill:brainstorming",
                                    --   "tool:pi:edit", "mcp:context7:resolve-library-id"
  kind          TEXT,               -- 'skill' | 'tool' | 'mcp'
  source        TEXT,               -- skill dir / 'pi' / mcp server id   (namespacing root)
  name          TEXT,               -- display name (server-namespaced for mcp)
  summary       TEXT,               -- one-paragraph description (shown in search results)
  activation    TEXT,               -- JSON payload the Activator needs (path / tool name /
                                    --   server+tool). HEAVY schema lives here, NOT in FTS.
  content_hash  TEXT,               -- staleness key
  updated_at    TEXT)

-- Multi-column FTS so param text aids recall but cannot swamp ranking (the G4 decision).
-- Standalone (contentless) FTS5 — 'params' is not a column on `capability`, so we keep the
-- FTS rows in sync on upsert rather than using external-content:
capability_fts USING fts5(
  id UNINDEXED, name, summary, params)   -- 'params' = flattened param names/descs/enums (tools/mcp)
-- Query uses weighted BM25:  bm25(capability_fts, 0.0, 8.0, 4.0, 1.0)  -- id col unweighted
--   name >> summary >> params, so a strong name/summary match outranks incidental param hits.

usage(
  id            TEXT PRIMARY KEY,   -- capability id
  count         INT  DEFAULT 0,
  last_used_at  TEXT)               -- promotion signal (§7); fed by tool_execution_end
```

**Why multi-column FTS5 (G4).** A skill is freeform prose; a tool/MCP call is name + terse
description + a structured JSON Schema. Indexing only name+description loses param semantics
("the tool with a `sheet_id` arg"); dumping the whole schema into one FTS column lets noisy
schema text dominate BM25. Splitting into `name | summary | params` with descending BM25
weights captures param recall **and** keeps it subordinate — one knob, no reranking pass.

**Derived & rebuildable.** Every row is reconstructable from live sources (§8). No
provenance or curation lives only in the DB, so the gitignored `index.db` is safe to drop.

---

## 5. The Capability record & per-kind assembly

```ts
type Kind = "skill" | "tool" | "mcp";
interface Capability {
  id: string;            // `${kind}:${source}:${localName}` — stable, collision-free (G6)
  kind: Kind;
  source: string;
  name: string;
  summary: string;
  searchText: { name: string; summary: string; params: string };  // → capability_fts
  activation: unknown;   // kind-specific; consumed only by the Activator (§6)
}
```

| Kind | `name` | `summary` | `params` | `activation` |
|---|---|---|---|---|
| `skill` | skill name | description | `""` (skills have no params) | `{ skillDir, filePath }` (package root + `SKILL.md`) |
| `tool` | tool name | description | flattened `argName: argDesc (enum: a\|b)` | `{ toolName }` |
| `mcp` | `server__tool` | description | flattened from cached JSON Schema | `{ server, tool }` |

`params` flattening is deterministic: depth-first over the schema, emit `path: description`
plus enum values; truncate per-field to bound size. The full schema is **never** copied into
the index — only into `activation` (and even there, by reference to the adapter cache for MCP).

---

## 6. Activation — one tool, three Activators (the G3 solution)

`capability_search` and `capability_activate` are the **only** capability tools the agent
sees. The heterogeneity (skills rewrite the prompt block; native tools use `setActiveTools`;
MCP rides the adapter proxy) is closed behind a Strategy interface:

```ts
interface Activator {
  kind: Kind;
  activate(cap: Capability): { available: "now" | "next-turn"; payload?: unknown };
  deactivate?(cap: Capability): void;
}
```

- **`SkillActivator`** — add the skill into the slim `<available_skills>` block (so it stays
  discoverable) and return its `filePath`; the agent loads it by reading the file. *next-turn.*
- **`ToolActivator`** — `pi.setActiveTools([...pi.getActiveTools(), cap.activation.toolName])`.
  Verified by the spike: `setActiveToolsByName` swaps the active set, rebuilds the prompt, and
  "takes effect on the next agent turn." Must always re-include PI's base tools (§10). *next-turn.*
- **`McpActivator`** — return the adapter's `describe(tool)` schema (pay-per-use) so the agent
  can call it through the `mcp` proxy immediately; optionally promote to the adapter's
  `directTools` for repeat use. *now* (via proxy) or *next-turn* (if promoted to a Pi tool).

**Search signature:** `capability_search(query, { kind?: 'skill'|'tool'|'mcp'|'all', k=8 })`
→ weighted BM25 over `capability_fts`, filtered by `kind` (default `'all'`), returns light
hits `{ id, kind, name, summary, score }[]` — **no schema** (that waits for activate, §3 ¶3).

`capability_activate(id)` → look up record → `activators[cap.kind].activate(cap)` → return the
uniform `{ available, payload }`. **The index, both tools, loadouts, and promotion are all
kind-agnostic; only three ~20-line Activators know the differences.** Adding a 4th kind later
is one new Activator, zero changes elsewhere.

### 6.1 The skills interceptor (Phase 1 mechanism)

Two separable mechanisms — **indexing** (authoritative) and **prompt-slimming** (display):

**Index source = PI's own `loadSkills()`** (`skills.d.ts:59`, exported), which returns *all*
skills with `name / description / filePath / baseDir / disableModelInvocation` — **including
`disable-model-invocation` skills** that never appear in the prompt block. We import it
directly: zero re-implementation of discovery rules, and **G8 is resolved** — search sees every
skill regardless of its prompt visibility. Refreshed at `session_start` (hash-gated). This
scales: at 500+ skills the index is built from a directory walk PI already implements, not from
re-parsing a 500 KB prompt string every turn.

**Prompt-slimming** runs in `before_agent_start`, where PI hands us `event.systemPrompt`
(already containing the assembled `<available_skills>` block, `system-prompt.js:113`) and our
return value **replaces** `agent.state.systemPrompt` (`agent-session.js:792`). Each turn:

1. **Locate** the `<available_skills>…</available_skills>` markers (boundaries only — we do
   *not* parse their contents).
2. **Replace** the whole block with our own rendering of the active loadout's skills (full
   descriptions, from the index) + one line: *"More skills available — call
   `capability_search` to find them."*
3. Return the modified prompt. **Fail-open:** markers not found (PI changed format) → return
   the prompt untouched. Composes with the Library's kb-policy hook (the runner threads
   `currentSystemPrompt` through both).

---

## 7. Loadouts & promotion

### 7.1 Loadouts (curation — #1)
A loadout is a named always-on working set, kind-agnostic (refers to capabilities by `id`):

```yaml
# loadouts.yaml
core: [skill:brainstorming, skill:debugging, tool:pi:edit]   # always-on, every loadout
active: base                                                  # default active pointer
loadouts:
  base:     { description: "general work", skills: [], tools: [], mcp: [] }
  frontend: { description: "UI work", skills: [skill:frontend-design], tools: [], mcp: [mcp:playwright:screenshot] }
```

Applying a loadout = `core ∪ named` → for each id call its Activator to the always-on tier
(skills into the slim block, tools into the active set, MCP promoted to `directTools`).

### 7.2 LoadoutService → frontend-ready CRUD (the API endpoint, #8-ready)
A plain typed module is the **single source of truth**; tools, slash commands, and a future
frontend (#8) are thin clients over it.

```
listLoadouts()                          → Loadout[]
getLoadout(name)                        → Loadout | null
createLoadout(name, { skills?, tools?, mcp?, description? })
updateLoadout(name, patch)              // rename, set desc, replace lists
addCapability(name, capId) / removeCapability(name, capId)   // granular, kind-agnostic
deleteLoadout(name)
getActive() / setActive(name)           // session-scoped active pointer
validate(name)                          // warn on ids that no longer resolve (drift, G9)
```

Stored in `loadouts.yaml` (files-as-truth). `validate` prevents silent drift: a loadout
naming a renamed/removed capability surfaces a warning instead of vanishing from the set.

> **Naming:** "loadout" deliberately avoids "preset" — `my-pi`/`pi-skills` already use
> "preset" for additive *prompt-text layers*, a different concept. Distinct name = no clash
> when these run side by side.

### 7.3 Promotion-on-use (anti-cold-start, G10/G15)
Cold-start tax: a capability that used to sit in the prompt now costs a search round-trip.
Mitigation — usage telemetry auto-elevates hot capabilities:

- A `pi.on("tool_execution_end", …)` handler increments `usage(count, last_used_at)`. Skill
  "use" is detected as a `read` tool_call on a path under a skills dir.
- At `before_agent_start`, after applying the loadout, **auto-activate the top-N
  most-recently-used capabilities not already in the loadout**, up to a hard **ceiling**
  (config, default 5) so the active set can't creep back into bloat over a long session.
- Promotion is per-session and ephemeral by default; `/loadout promote <id>` persists a hot
  capability into the active loadout. (Built on our own `usage` table — `pi-telemetry` is
  referenced for the idea, not installed; see §9.)

---

## 8. Index build & refresh (per-kind freshness, G6)

The index is derived; each kind has a refresh trigger matched to how it changes:

| Kind | Source of truth | Refresh trigger |
|---|---|---|
| `skill` | PI's exported `loadSkills()` (all skills, incl. hidden) | `session_start`, hash-gated |
| `tool`  | `pi.getAllTools()` | `session_start` + on `refreshTools` |
| `mcp`   | adapter's on-disk catalog cache | `session_start`, `/cap-refresh`, or cache mtime change |

`content_hash` gates re-indexing to changed records only. A `/cap-reindex` command forces a
full rebuild. MCP servers that change their tool set between versions are caught by the cache
mtime check; nothing live is contacted during search (the adapter caches metadata to disk).

---

## 9. Coexistence & dependencies

| Surface | This extension (`pi-capability-index`) | Neighbors |
|---|---|---|
| Storage | `~/.pi/capabilities/`, `<repo>/.pi/capabilities/` | KB: `~/.pi/kb/`; Hermes: `~/.pi/agent/pi-hermes-memory/` |
| SQLite | `index.db` (capability) | KB `index.db`; Hermes `sessions.db` — disjoint files |
| Tools | `capability_search/activate/add`, `loadout_*` | KB `kb_*`; Hermes `memory_*` |
| Commands | `/loadout`, `/cap-search`, `/cap-refresh`, `/cap-reindex` | `/kb-*`, `/memory-*` |
| Prompt hook | rewrites `<available_skills>` block | KB appends `<kb-policy>` — composes, runner threads prompt |

- **Install (one real dependency):** an MCP transport (`pi-mcp-adapter` or `pi-mcp`) — being
  an MCP client is a stateful external subsystem (transport, lifecycle, schema translation).
- **Reference, don't install:** `pi-telemetry` (we need one `usage` table + an event hook we
  already have); `pi-skills`/`my-pi` presets (different concepts).
- **Shared engine:** the FTS5 setup, BM25 normalization (Library §5.1), and content-hash
  reindex are common with the Research Library — factored into a small shared local module
  rather than duplicated. Both extensions import it.

---

## 10. Implementation notes & risks

- **`setActiveTools` must preserve PI's base tools.** `ToolActivator` reads
  `pi.getActiveTools()` and *appends*; never replaces. Deactivation never drops base
  (`read/bash/edit/write`) tools. A bad active set bricks the agent — guard with a pinned base.
- **Adapter runtime-promotion is unverified.** `pi-mcp-adapter`'s `directTools` is documented
  as *config-time*; promoting at runtime may not be supported. **Feasibility check before
  Phase 3:** if not, MCP activation stays proxy-only (still fine — `McpActivator` returns the
  `describe` payload and the agent calls through the proxy; promotion just won't apply to MCP).
- **Skills-block format coupling (G7).** The rewrite keys off literal `<available_skills>`
  markers; version it and **fail open** on miss. A unit test asserts our regex against PI's
  current `formatSkillsForPrompt` output, so a PI upgrade that changes the format fails the
  test loudly instead of silently no-op'ing in production.
- **Untrusted capability text (security, G11/G13).** MCP tool names/descriptions are
  third-party text that enters our index and reaches the agent — a prompt-injection vector.
  Surface capability text as **data, not instructions** in search results; never let a
  description trigger auto-activation. `capability_add` (skill authoring) runs the Library's
  secret scanner before writing a `SKILL.md`.
- **Dedup-on-add.** `capability_add` BM25-searches the existing skill index on the proposed
  description and warns on a near-duplicate before scaffolding (mirrors KB dedup-on-write).
- **Promotion ceiling is load-bearing.** Without the hard cap (§7.3) the active set drifts
  back to baseline bloat over a long session — the cap is a correctness requirement, not a
  nicety.
- **DB write concurrency.** WAL mode; reindex is idempotent. If subagents share the global
  `index.db`, serialize writes with a short-held lock (`proper-lockfile`, already a PI dep).

---

## 11. Phasing & open / deferred

**Build phases (each ships independently; the architecture is whole from Phase 1):**
- **Phase 1 — skills.** Index via `loadSkills()`, slim-block rewrite, `SkillActivator`,
  loadouts + CRUD, `capability_search/activate/add` (with `kind` filter), promotion. The certain
  win; no new dependencies. *(This subsumes the earlier "skills-v1" spec.)*

  **Decision (post-build, 2026-06-12) — global index is cwd-INDEPENDENT.** The reindex
  (`ctx.refresh()`) deliberately does **not** scan `<cwd>/.pi/skills` (the repo `pi` was
  launched from). Two reasons: (a) `loadSkills(includeDefaults:true)` recurses that dir
  following directory symlinks with no cycle guard, and the reindex is synchronous — a large
  or symlink-cyclic repo tree froze `/cap-reindex` (observed timeout); (b) a *global*
  `~/.pi/capabilities/index.db` must not change based on where you happened to start `pi`.
  So `refresh()` scans only bounded, cwd-independent roots: `~/.pi/skills` (authored) +
  `~/.pi/agent/skills` (PI user skills) + explicit paths. **Consequence:** repo-local skills
  in `<repo>/.pi/skills` are not searchable in v1.
- **Phase 2 — native/extension tools.** `ToolActivator` via `setActiveTools`; index from
  `getAllTools()`. Gated on the base-tool-preservation guard (§10).
- **Phase 3 — MCP.** Adopt the transport package; index its cache; `McpActivator`. Gated on
  the runtime-promotion feasibility check (§10).

**Deferred (tracked, not built):** semantic/embedding ranking (the multi-column FTS is the
v1 substitute) · LSP-action & prompt-template kinds (new Activators) · cross-machine loadout sync ·
per-capability access control (matters once remote #8 exists) · loadout inheritance/composition
(layering beyond `core ∪ named`) · multi-root resolution (which `.pi/capabilities` in
monorepos/worktrees) · usage-decay (promotion weighting that ages out stale hot capabilities) ·
**repo-local skill index** — make `<repo>/.pi/skills` searchable again, but in a *project-scoped*
DB (`<repo>/.pi/capabilities/index.db`) merged at query time, instead of polluting/hanging the
global index (the cwd-independence decision above is the v1 stance; this is the proper fix).

**Open feasibility checks (run before the gated phase):**
1. *(Phase 2)* Does `setActiveTools` cleanly coexist with the skills-block rewrite when both
   fire in `before_agent_start` across two extensions (ordering stable)?
2. *(Phase 3)* Can the adopted adapter promote a tool to first-class **at runtime**, or only
   via config? Determines whether MCP gets `directTools` promotion or stays proxy-only.

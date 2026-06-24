# pi-capability-index

> **Dev doc for the agent/developer working on this extension.** Read this first. It explains
> what PI is, what this extension does, how it's built, and the conventions to keep.

A PI extension that turns the agent's **capabilities** (skills, tools, and — later — MCP calls)
into a searchable index, so they stay **out of the baseline context** and the agent **pinpoints
and activates** the few it needs on demand. A small curated **loadout** is always-on; the long
tail is one `capability_search` away.

---

## 1. What is PI (the base we extend)

**PI** (`@earendil-works/pi-coding-agent`) is a lean, embeddable coding agent — a CLI/TUI plus
an SDK. We do not fork it; we **extend it in-place** via its extension API.

Things to know about PI before touching this code:

- **Extensions** are TypeScript modules loaded via **jiti at runtime — no build step.** A package
  with `"type":"module"` and a `pi` manifest (`"pi": { "extensions": ["./index.ts"] }`) placed
  under `~/.pi/agent/extensions/<name>/` is **auto-discovered**. The default export is
  `(pi: ExtensionAPI) => void`.
- **Tools** are functions the model can call: `{ name, description, parameters: Type.Object(...), execute }`,
  registered with `pi.registerTool(...)`. The model sees a tool's name + description + JSON-Schema.
- **Skills** are packaged instructions: a directory with a `SKILL.md` (+ optional bundled scripts/docs).
  PI discovers them via `loadSkills()` and **injects every skill's name + description (≤1024 chars)
  into the system prompt** in an `<available_skills>` block, every turn. "Invoking" a skill =
  reading its `SKILL.md`.
- **Hooks** via `pi.on(event, handler)`. The ones we use:
  - `session_start` — fired once per session.
  - `before_agent_start` — fired each turn; receives `event.systemPrompt`; **the value you return
    `{ systemPrompt }` replaces the prompt** for that turn (runner threads it across extensions).
  - `tool_result` — fired after a tool runs; carries `{ toolName, input, content, isError }`
    (note: `tool_execution_end` does **not** carry the tool args; `tool_result` does).
- **Dynamic tool control** (key for Phase 2): `pi.getAllTools()` (registered set), `pi.getActiveTools()`
  (active subset the model sees), `pi.setActiveTools(names)` (set the active subset — rebuilds the
  base prompt, takes effect next turn). Registration is eager; there is **no `unregisterTool`** —
  deferral is done by toggling *active* vs *registered*, not by removing.
- **PI philosophy:** deliberately **no native MCP** — the maintainer's stated reason is MCP's context
  overhead (every server dumps all its tool schemas into the prompt). That anti-"dump everything into
  context" stance is exactly what this extension generalizes and solves.

PI's own source is the source of truth for these APIs:
`node_modules/@earendil-works/pi-coding-agent/dist/core/...` (read `skills.js`, `system-prompt.js`,
`agent-session.js`, `extensions/types.d.ts`).

---

## 2. What this project is

As skills/tools/MCP grow into the hundreds, PI's "inject everything every turn" approach bloats
context (e.g. one MCP server ≈ 13–18k tokens before you start). This extension is the **"tiny
internet search" over the agent's own capabilities**:

1. **Index** every capability into a SQLite **FTS5/BM25** index (derived, rebuildable, gitignored).
2. **Slim the prompt:** rewrite PI's `<available_skills>` block to just the active **loadout** +
   a pointer to `capability_search` (skills, default-on). Optionally deactivate non-loadout tools
   (`CAP_DEFER_TOOLS=1`).
3. **Search & activate on demand:** `capability_search(query, {kind})` → ranked hits;
   `capability_activate(id)` → loads one (skill = its `SKILL.md` path; tool = `setActiveTools`).
4. **Curate & adapt:** **loadouts** (named always-on sets, full CRUD) + **promotion** (recently-used
   capabilities auto-kept, with a ceiling).

### Where it fits the bigger "custom PI agent" (the harness)
This is one of three sibling extensions, all sharing the same files-as-truth + FTS5 engine, split by
*what they know*:

| Extension | Knows | Status |
|---|---|---|
| **pi-hermes-memory** | *you* — prefs, lessons, session recall (memory) | adopt, not built (decision) |
| **pi-research-library** (`kb_*`) | *the documents* — sourced/cited reference docs | built |
| **pi-capability-index** (this) | *your capabilities* — skills/tools/mcp | built (Phases 1–2) |

See `~/.pi/docs/feature-groupings.md` for the full harness decomposition.

---

## 3. Architecture

### Core data model (`src/types.ts`)
```ts
type Kind = "skill" | "tool" | "mcp";
interface Capability {
  id: string;        // `${kind}:...` stable id — "skill:brainstorming", "tool:pi:kb_search"
  kind: Kind;
  source: string;    // skill baseDir / "pi" / mcp server
  name: string;
  summary: string;
  searchText: { name; summary; params };  // the 3 weighted FTS columns
  activation: unknown;                     // kind-specific (filePath / toolName / ...)
}
```

### The index (`src/schema.ts`, `src/db.ts`, `src/index-store.ts`, `src/search.ts`)
- One `node:sqlite` DB at `~/.pi/capabilities/index.db` (WAL, **gitignored**, rebuildable).
- `capability` table + a **multi-column FTS5** virtual table `capability_fts(id, name, summary, params)`.
- Search = weighted BM25: `bm25(capability_fts, 0, 8, 4, 1)` (name ≫ summary ≫ params), min-max
  normalized to a 0–1 score + a confidence tier. `kind` filter scopes to one set or searches all.
- **Why multi-column:** param text aids recall for tools/MCP but must not swamp ranking — hence
  the low weight on `params`. (This is the v1 substitute for semantic embeddings, which are deferred.)

### Find vs Activate — the Strategy pattern (`src/activators/`)
One index, **one search tool + one activate tool**, but three different *activation mechanisms* hidden
behind an `Activator` interface:
- `SkillActivator` → adds the skill to `ctx.sessionActive` (so next turn's slim block includes it) +
  returns its `SKILL.md` path to read.
- `ToolActivator` → `setActiveTools([...getActive(), toolName])` via `ctx.tools` (a `ToolControl`).
- `McpActivator` → **Phase 3, not built** (registry `default:` throws "later phase").

`activatorFor(kind, deps)` dispatches; `capability_activate` catches the throw for unbuilt kinds.

### Loadouts (`src/loadouts.ts`)
`LoadoutService` = the frontend-ready CRUD source of truth over `~/.pi/capabilities/loadouts.yaml`
(`createLoadout/updateLoadout/add/removeCapability/delete/setActive/getActive/getActiveSkillIds/
getActiveToolIds/validate`). A loadout is `{ name, skills[], tools[], mcp[] }`; `core` is an always-on
set. The agent tool `loadout` and the `/loadout` command are thin clients over this service.

### Promotion (`src/usage.ts`, `src/promotion.ts`)
`tool_result` → `recordSkillReadFromEvent` (a `SKILL.md` read) and `recordUsage("tool:pi:<name>")`.
`computeActiveIds`/`topRecentIds` auto-keep recently-used capabilities up to a **ceiling**
(`CAP_PROMOTION_CEILING`, default 5) so the active set can't creep back to bloat.

### Runtime wiring (`index.ts`)
- `session_start`: `ctx.refresh()` (index skills via `loadSkills`) → `indexTools(pi)` (index native
  tools via `getAllTools`) → **if `CAP_DEFER_TOOLS`** → `applyToolDeferral(pi)`.
- `tool_result`: record skill-read + tool usage (best-effort, never throws into PI).
- `before_agent_start`: compute active skill set (loadout ∪ session ∪ promoted) → `slimSkillsBlock` →
  append `<capability-policy>` → return `{ systemPrompt }`. **Skills only — never touches tools here**
  (see invariant below).

---

## 4. Module map

```
index.ts                  wiring: register 5 tools, 3 commands, 3 hooks; indexTools + applyToolDeferral helpers
src/
  types.ts                Capability, Kind, Loadout, CapSearchResult, ActivationResult
  paths.ts                ~/.pi/capabilities roots + authoredSkillsDir (~/.pi/skills)
  hash.ts  schema.ts  db.ts   sha256; DDL; openDb (WAL + FTS5)
  flatten.ts              JSON-Schema params -> searchable string (tools/mcp)
  index-store.ts          upsert/get/getCapabilities/delete/allIds/countByKind + FTS sync
  search.ts               capabilitySearch(db, query, {kind,k}) -> ranked CapSearchResult
  harvest/skills.ts       loadSkills() -> skill capabilities (incl. disable-model-invocation skills)
  harvest/tools.ts        getAllTools() -> tool capabilities; ALWAYS_ACTIVE allowlist
  loadouts.ts             LoadoutService (CRUD over loadouts.yaml)
  prompt-rewrite.ts       slimSkillsBlock(prompt, skills) — fail-open block replacement
  usage.ts  promotion.ts  usage table + recordSkillReadFromEvent; computeActiveIds (ceiling)
  tool-deferral.ts        computeActiveToolNames (which tools stay active under deferral)
  activators/             types (Activator, ToolControl, ActivatorDeps), skill, tool, registry
  cap-context.ts          buildCapContext(): db, loadouts, sessionActive, tools?, refresh()
  policy.ts               capPolicy(style) -> <capability-policy> block
  secrets.ts              findSecret() — pre-write scan for capability_add
  commands.ts             /loadout, /cap-reindex, /cap-status
  tools/                  capability_search, capability_activate, capability_add, loadout, capability_status
```

---

## 5. Invariants & conventions (do not break these)

- **Files are truth; the DB is derived.** Skills = their `SKILL.md`; loadouts = `loadouts.yaml`; the
  index rebuilds from them. Never store anything only in the DB.
- **Fail open, never closed.** `slimSkillsBlock` returns the prompt byte-for-byte unchanged if the
  `<available_skills>` markers are missing; `before_agent_start`/`session_start`/`tool_result` are
  wrapped so an error never breaks the host agent.
- **The global index is cwd-INDEPENDENT.** `refresh()` scans only `~/.pi/skills` + `~/.pi/agent/skills`
  + explicit paths — **never `<cwd>/.pi/skills`**. (Scanning the launch dir froze `/cap-reindex` and
  polluted the global index. Repo-local skills are a deferred project-scoped feature.)
- **Tool deferral is `session_start`-only.** Never call `setActiveTools` inside `before_agent_start`
  — that hook *returns* a slimmed prompt built from the pre-call base, which would clobber a same-hook
  prompt rebuild.
- **Always-active allowlist** (`harvest/tools.ts:ALWAYS_ACTIVE`) — base tools (`read/bash/edit/write/
  grep/find/ls`) and our own `capability_*`/`loadout` are never indexed or deactivated. This is what
  guarantees the agent can always recover a deferred tool.
- **Agents can't read their own system prompt.** To verify slimming/promotion, use `capability_status`
  (reports `slimBlockWillShow`) — not the model's self-report.
- **TDD.** Failing test first. `execute(_id, p)` tool signatures use `as any` at registration (PI's
  `ToolDefinition` expects more params); the factory files stay tsc-clean in isolation.

---

## 6. Develop & verify

```bash
npm install          # no native build — uses stdlib node:sqlite (Node 22.5+)
npm test             # vitest (currently ~55 tests)
npm run check        # tsc --noEmit
node scripts/smoke-load.mjs   # loads index.ts through PI's jiti -> must print LOAD_OK
```
`scripts/smoke-load.mjs` is the gate that proves the extension **loads in PI** (5 tools / 3 hooks).
There is **no build step** — PI runs `index.ts` directly via jiti.

### Load it in PI
It auto-discovers from `~/.pi/agent/extensions/pi-capability-index/`. Just run `pi`. On first load it
creates `~/.pi/capabilities/{index.db, loadouts.yaml, .gitignore}`.

### Env vars
| Var | Default | Effect |
|---|---|---|
| `CAP_POLICY` | `compact` | `<capability-policy>` verbosity: `full` \| `compact` \| `none` |
| `CAP_PROMOTION_CEILING` | `5` | max auto-promoted capabilities beyond the loadout |
| `CAP_DEFER_TOOLS` | (unset) | when set, deactivate non-loadout tools at session start (opt-in) |

### Agent surface
Tools: `capability_search`, `capability_activate`, `capability_add`, `loadout`, `capability_status`.
Commands: `/loadout [name]`, `/cap-reindex`, `/cap-status`.

---

## 7. Phasing & status

- **Phase 1 — skills:** ✅ index, slim-block (default-on), search/activate/add, loadouts, promotion.
- **Phase 2 — native tools:** ✅ index via `getAllTools`, `ToolActivator` via `setActiveTools`,
  `kind:"tool"` search, tool-loadouts, **opt-in** deferral.
- **Phase 3 — MCP:** ⬜ not built. Adopt an MCP transport (`pi-mcp-adapter`/`pi-mcp`), index its
  catalog, add `McpActivator`. Gated by a feasibility check: can the adapter promote a tool to
  first-class at runtime, or only via config?

**Not yet (known scope):** semantic/embedding ranking (it's lexical BM25); automatic/predictive
pre-selection (the agent *pulls* via search — nothing auto-pushes capabilities for a task).

### Reference docs (in `~/.pi/docs/`)
- Spec: `docs/superpowers/specs/2026-06-12-capability-index-design.md`
- Plans: `docs/superpowers/plans/2026-06-12-capability-index.md` (Phase 1),
  `...-capability-index-phase2-tools.md` (Phase 2)
- Sibling spec: `...-research-library-design.md`; harness map: `docs/feature-groupings.md`

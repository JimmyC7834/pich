# Capability Index — Phase 2 (Native Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend `pi-capability-index` so native PI tools (other extensions' tools like `kb_*`, and any registered tool except a fixed always-active allowlist) are indexed as `kind:"tool"`, searchable, activatable, and loadout-scopable — with **opt-in** deferral (`CAP_DEFER_TOOLS=1`) that deactivates non-essential tools at session start so the agent reactivates them on demand.

**Architecture (decided):** Tools are harvested at runtime via `pi.getAllTools()` (only available with the `pi` object, so harvest lives in `index.ts`, not `cap-context`). Activation uses `pi.setActiveTools()` through a `ToolControl` interface placed on `ctx.tools`. **Deferral is applied once at `session_start`** (and incrementally by `ToolActivator`), NEVER in `before_agent_start` — because `before_agent_start` returns a slimmed prompt built from the pre-call base, which would clobber a same-hook `setActiveTools` prompt rebuild. By default (no env flag) tools are indexed/searchable but nothing is deactivated.

**Tech Stack:** same as Phase 1 (TS/ESM, better-sqlite3, typebox, vitest). Builds on the existing extension at `~/.pi/agent/extensions/pi-capability-index/`. Reference spec §6/§10/§11 of `docs/superpowers/specs/2026-06-12-capability-index-design.md`.

**Always-active allowlist (never indexed or deferred):** PI built-ins `read, bash, edit, write, grep, find, ls` + our own `capability_search, capability_activate, capability_add, loadout, capability_status`.

---

## Subagent Execution Strategy

Serial, fresh subagent per task (shared git repo — no parallel implementers). Waves batch related tasks. Deep review on **T4** (deferral set computation — a wrong set hides tools) and **T6** (wiring, esp. the session_start-only deferral and the prompt-ordering rule).

| Wave | Tasks | Review |
|---|---|---|
| A | T1 tool-harvest · T2 ToolActivator | spec-check, light |
| B | T3 ctx.tools + loadout tool-ids · T4 deferral computation | **Deep on T4** |
| C | T5 activate wiring · T6 index.ts wiring + e2e/smoke | **Deep on T6** + final review |

Existing invariants to preserve: 5 registered tools / 3 hooks (no new tools or events in Phase 2), `tsc` clean, jiti `LOAD_OK`.

---

## Task 1: Harvest native tools → capabilities

**Files:** Create `src/harvest/tools.ts`; Test `test/harvest-tools.test.ts`

- [ ] **Step 1: failing test**

```ts
import { test, expect } from "vitest";
import { harvestTools, toolToCapability, ALWAYS_ACTIVE } from "../src/harvest/tools.js";

test("toolToCapability maps a ToolInfo to a tool capability with flattened params", () => {
  const cap = toolToCapability({ name: "kb_search", description: "search the library",
    parameters: { type: "object", properties: { query: { type: "string", description: "the query" } } } });
  expect(cap.id).toBe("tool:pi:kb_search");
  expect(cap.kind).toBe("tool");
  expect((cap.activation as any).toolName).toBe("kb_search");
  expect(cap.searchText.params).toContain("query");
});

test("harvestTools skips the always-active allowlist (built-ins + our own tools)", () => {
  const all = [
    { name: "read", description: "x" }, { name: "capability_search", description: "x" },
    { name: "kb_search", description: "search docs" }, { name: "kb_open", description: "open a doc" },
  ];
  const caps = harvestTools(all);
  const ids = caps.map((c) => c.id);
  expect(ids).toEqual(["tool:pi:kb_search", "tool:pi:kb_open"]);
  expect(ALWAYS_ACTIVE.has("read")).toBe(true);
  expect(ALWAYS_ACTIVE.has("capability_search")).toBe(true);
});
```

- [ ] **Step 2: run → FAIL** (`npx vitest run test/harvest-tools.test.ts`)
- [ ] **Step 3: implement** `src/harvest/tools.ts`

```ts
import type { Capability } from "../types.js";
import { flattenParams } from "../flatten.js";

/** Tools that must ALWAYS stay active and are never indexed/deferred. */
export const ALWAYS_ACTIVE = new Set<string>([
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "capability_search", "capability_activate", "capability_add", "loadout", "capability_status",
]);

export interface ToolInfoLike { name: string; description?: string; parameters?: unknown; }

export function toolToCapability(t: ToolInfoLike): Capability {
  const summary = t.description ?? "";
  return {
    id: `tool:pi:${t.name}`,
    kind: "tool",
    source: "pi",
    name: t.name,
    summary,
    searchText: { name: t.name, summary, params: flattenParams(t.parameters) },
    activation: { toolName: t.name },
  };
}

export function harvestTools(all: ToolInfoLike[]): Capability[] {
  return all.filter((t) => !ALWAYS_ACTIVE.has(t.name)).map(toolToCapability);
}
```

- [ ] **Step 4: run → PASS**
- [ ] **Step 5: commit** `git add src/harvest/tools.ts test/harvest-tools.test.ts && git commit -m "feat: harvest native tools into the capability index"`

---

## Task 2: ToolActivator + registry wiring

**Files:** Modify `src/activators/types.ts`; Create `src/activators/tool.ts`; Modify `src/activators/registry.ts`; Test `test/tool-activator.test.ts`

- [ ] **Step 1: failing test** `test/tool-activator.test.ts`

```ts
import { test, expect } from "vitest";
import { activatorFor } from "../src/activators/registry.js";
import type { Capability } from "../src/types.js";

function toolCap(name: string): Capability {
  return { id: `tool:pi:${name}`, kind: "tool", source: "pi", name, summary: "",
    searchText: { name, summary: "", params: "" }, activation: { toolName: name } };
}

test("ToolActivator adds the tool to the active set via ToolControl and marks session", () => {
  let active = ["read", "capability_search"];
  const tools = { getActive: () => active, setActive: (n: string[]) => { active = n; } };
  const session = new Set<string>();
  const act = activatorFor("tool", { sessionActive: session, tools });
  const res = act.activate(toolCap("kb_search"));
  expect(res.available).toBe("next-turn");
  expect(active).toContain("kb_search");
  expect(session.has("tool:pi:kb_search")).toBe(true);
});

test("activating a tool without a ToolControl throws (caught by the activate tool)", () => {
  const act = activatorFor("tool", { sessionActive: new Set() });
  expect(() => act.activate(toolCap("kb_search"))).toThrow();
});
```

- [ ] **Step 2: run → FAIL**
- [ ] **Step 3a: modify `src/activators/types.ts`** — add `ToolControl` and extend deps:

```ts
import type { Capability, ActivationResult, Kind } from "../types.js";

export interface ToolControl { getActive(): string[]; setActive(names: string[]): void; }

export interface ActivatorDeps { sessionActive: Set<string>; tools?: ToolControl; }

export interface Activator {
  kind: Kind;
  activate(cap: Capability): ActivationResult;
}
```

- [ ] **Step 3b: create `src/activators/tool.ts`**

```ts
import type { Activator, ActivatorDeps } from "./types.js";
import type { Capability, ActivationResult } from "../types.js";

export class ToolActivator implements Activator {
  kind = "tool" as const;
  constructor(private deps: ActivatorDeps) {}
  activate(cap: Capability): ActivationResult {
    const tc = this.deps.tools;
    if (!tc) throw new Error("tool activation unavailable (no tool controller wired)");
    const toolName = (cap.activation as { toolName?: string })?.toolName;
    if (!toolName) throw new Error(`capability ${cap.id} has no toolName`);
    this.deps.sessionActive.add(cap.id);
    const active = tc.getActive();
    if (!active.includes(toolName)) tc.setActive([...active, toolName]);
    return { available: "next-turn", payload: { toolName } };
  }
}
```

- [ ] **Step 3c: modify `src/activators/registry.ts`** — add the `tool` case:

```ts
import type { Kind } from "../types.js";
import type { Activator, ActivatorDeps } from "./types.js";
import { SkillActivator } from "./skill.js";
import { ToolActivator } from "./tool.js";

export function activatorFor(kind: Kind, deps: ActivatorDeps): Activator {
  switch (kind) {
    case "skill": return new SkillActivator(deps);
    case "tool": return new ToolActivator(deps);
    // "mcp" -> Phase 3
    default: throw new Error(`No activator for kind '${kind}' (built in a later phase)`);
  }
}
```

- [ ] **Step 4: run → PASS**; also run full `npx vitest run` (SkillActivator test must still pass — deps shape unchanged for it).
- [ ] **Step 5: commit** `git add src/activators && git add test/tool-activator.test.ts && git commit -m "feat: ToolActivator via setActiveTools + ToolControl deps"`

---

## Task 3: ctx.tools field + loadout tool-ids

**Files:** Modify `src/cap-context.ts` (add `tools?` field); Modify `src/loadouts.ts` (add `getActiveToolIds`); Test extend `test/loadouts.test.ts`

- [ ] **Step 1: failing test** — append to `test/loadouts.test.ts`:

```ts
test("getActiveToolIds returns core ∪ active loadout tools, filtered to tool:", () => {
  const s = svc();
  s.createLoadout("dev", { tools: ["tool:pi:kb_search"], skills: ["skill:x"] });
  s.setActive("dev");
  const ids = s.getActiveToolIds();
  expect(ids).toContain("tool:pi:kb_search");
  expect(ids).not.toContain("skill:x");
});
```

- [ ] **Step 2: run → FAIL** (`npx vitest run test/loadouts.test.ts`)
- [ ] **Step 3a: add to `src/loadouts.ts`** (next to `getActiveSkillIds`):

```ts
  getActiveToolIds(): string[] {
    const d = this.read();
    const lo = d.loadouts[d.active];
    const ids = new Set<string>([...d.core, ...(lo?.tools ?? [])]);
    return [...ids].filter((id) => id.startsWith("tool:"));
  }
```

- [ ] **Step 3b: modify `src/cap-context.ts`** — add an optional tool controller to the interface (set later by `index.ts`), import the type:

Add to imports:
```ts
import type { ToolControl } from "./activators/types.js";
```
Add to the `CapContext` interface (after `authoredDir: string;`):
```ts
  tools?: ToolControl;
```
(No other change to `buildCapContext` — `index.ts` assigns `ctx.tools` after construction.)

- [ ] **Step 4: run full `npx vitest run` → PASS**; `npx tsc --noEmit` clean.
- [ ] **Step 5: commit** `git add src/loadouts.ts src/cap-context.ts test/loadouts.test.ts && git commit -m "feat: loadout tool-ids + ctx.tools controller slot"`

---

## Task 4: Deferral set computation (pure, Deep review)

**Files:** Create `src/tool-deferral.ts`; Test `test/tool-deferral.test.ts`

The rule: keep a tool active iff it is **not deferrable** (built-in/our-own/unindexed) **or** it is explicitly wanted (loadout ∪ session ∪ promoted). This never deactivates anything outside the indexed deferrable set, so base tools and other always-active tools can't be lost.

- [ ] **Step 1: failing test**

```ts
import { test, expect } from "vitest";
import { computeActiveToolNames } from "../src/tool-deferral.js";

test("keeps non-deferrable tools always; deferrable only when wanted", () => {
  const keep = computeActiveToolNames({
    allToolNames: ["read", "capability_search", "kb_search", "kb_open", "kb_cite"],
    deferrableNames: new Set(["kb_search", "kb_open", "kb_cite"]),
    keepNames: new Set(["kb_search"]),  // e.g. loadout wants kb_search
  });
  expect(keep).toContain("read");             // base: always
  expect(keep).toContain("capability_search"); // ours: always
  expect(keep).toContain("kb_search");        // wanted deferrable
  expect(keep).not.toContain("kb_open");      // deferrable, not wanted -> deactivated
  expect(keep).not.toContain("kb_cite");
});

test("empty keepNames deactivates all deferrable tools but keeps the rest", () => {
  const keep = computeActiveToolNames({
    allToolNames: ["read", "kb_search", "kb_open"],
    deferrableNames: new Set(["kb_search", "kb_open"]),
    keepNames: new Set(),
  });
  expect(keep).toEqual(["read"]);
});
```

- [ ] **Step 2: run → FAIL**
- [ ] **Step 3: implement `src/tool-deferral.ts`**

```ts
export interface DeferralInput {
  allToolNames: string[];        // pi.getAllTools().map(t => t.name)
  deferrableNames: Set<string>;  // indexed tool capabilities, as bare tool names
  keepNames: Set<string>;        // bare tool names to keep active (loadout ∪ session ∪ promoted)
}

/** Tool names that should remain active when deferral is enabled. */
export function computeActiveToolNames(input: DeferralInput): string[] {
  return input.allToolNames.filter(
    (n) => !input.deferrableNames.has(n) || input.keepNames.has(n),
  );
}
```

- [ ] **Step 4: run → PASS**
- [ ] **Step 5: commit** `git add src/tool-deferral.ts test/tool-deferral.test.ts && git commit -m "feat: tool deferral active-set computation"`

---

## Task 5: capability_activate routes tool activations through ctx.tools

**Files:** Modify `src/tools/capability_activate.ts`; Test `test/tool-activate.test.ts` (extend)

- [ ] **Step 1: failing test** — append to `test/tool-activate.test.ts`:

```ts
test("activating a tool capability uses ctx.tools and reports next-turn", async () => {
  const c = ctx();
  let active = ["read"];
  c.tools = { getActive: () => active, setActive: (n) => { active = n; } };
  upsertCapability(c.db, { id: "tool:pi:kb_search", kind: "tool", source: "pi", name: "kb_search",
    summary: "search docs", searchText: { name: "kb_search", summary: "search docs", params: "" },
    activation: { toolName: "kb_search" } });
  const out = await makeCapabilityActivate(c).execute("1", { id: "tool:pi:kb_search" });
  const parsed = JSON.parse(out.content[0].text);
  expect(parsed.available).toBe("next-turn");
  expect(active).toContain("kb_search");
});
```

- [ ] **Step 2: run → FAIL** (`npx vitest run test/tool-activate.test.ts`) — current code builds deps without `tools`, so the ToolActivator throws and the tool returns a "Cannot activate" error string, failing the assertion.
- [ ] **Step 3: modify `src/tools/capability_activate.ts`** — pass `tools` into the activator deps:

Change the `activatorFor` call from:
```ts
        const act = activatorFor(cap.kind, { sessionActive: ctx.sessionActive });
```
to:
```ts
        const act = activatorFor(cap.kind, { sessionActive: ctx.sessionActive, tools: ctx.tools });
```

- [ ] **Step 4: run → PASS** (both old skill test and new tool test); full `npx vitest run` clean.
- [ ] **Step 5: commit** `git add src/tools/capability_activate.ts test/tool-activate.test.ts && git commit -m "feat: capability_activate routes tool activation through ctx.tools"`

---

## Task 6: Wire tool harvest + opt-in deferral in index.ts (Deep review)

**Files:** Modify `index.ts`; Modify `test/wiring.test.ts` (no surface change — assert still 5 tools / 3 events, and that a fake pi with getAllTools/getActiveTools/setActiveTools doesn't crash). Create `test/e2e-tools.test.ts`.

Design rules enforced here:
- `ctx.tools` is wired from `pi.getActiveTools`/`pi.setActiveTools`.
- `session_start`: refresh skills (existing) → harvest+index tools from `pi.getAllTools()` → prune stale `tool:` rows → **if `CAP_DEFER_TOOLS` is set**, apply deferral via `pi.setActiveTools(...)`. (Deferral applied HERE, not in before_agent_start.)
- `tool_result`: existing skill-read usage (unchanged) + record tool usage (`tool:pi:<name>`) for visibility.
- `before_agent_start`: UNCHANGED (skills only). Do NOT touch tools here.

- [ ] **Step 1: failing test** — `test/e2e-tools.test.ts`:

```ts
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";
import { buildCapContext } from "../src/cap-context.js";
import { harvestTools } from "../src/harvest/tools.js";
import { upsertCapability, allIds } from "../src/index-store.js";
import { capabilitySearch } from "../src/search.js";
import { makeCapabilityActivate } from "../src/tools/capability_activate.js";

test("harvested tools are searchable by kind:tool and activatable via ctx.tools", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "cap-e2etools-"));
  const ctx = buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
  let active = ["read", "capability_search"];
  ctx.tools = { getActive: () => active, setActive: (n) => { active = n; } };

  // simulate session_start tool harvest from pi.getAllTools()
  for (const c of harvestTools([
    { name: "read", description: "builtin" },               // excluded
    { name: "kb_search", description: "search the library" },
    { name: "kb_open", description: "open a document" },
  ])) upsertCapability(ctx.db, c);

  expect(allIds(ctx.db)).toEqual(expect.arrayContaining(["tool:pi:kb_search", "tool:pi:kb_open"]));
  const found = capabilitySearch(ctx.db, "search library", { kind: "tool" });
  expect(found.hits[0].id).toBe("tool:pi:kb_search");

  await makeCapabilityActivate(ctx).execute("1", { id: "tool:pi:kb_search" });
  expect(active).toContain("kb_search"); // ToolActivator pushed it into the active set
});
```

- [ ] **Step 2: run → PASS already?** This test exercises modules from T1–T5 (no index.ts needed). Run `npx vitest run test/e2e-tools.test.ts` → it should PASS, proving the unit pieces compose. (If it fails, fix the offending module before touching index.ts.)

- [ ] **Step 3: modify `index.ts`** — add imports:

```ts
import { harvestTools, ALWAYS_ACTIVE } from "./src/harvest/tools.js";
import { upsertCapability, allIds, deleteCapability, getCapabilities as _gc } from "./src/index-store.js";
import { computeActiveToolNames } from "./src/tool-deferral.js";
import { topRecentIds } from "./src/usage.js";
```
(Note: `getCapabilities` is already imported in index.ts for the skill slim path; do NOT double-import — only add `allIds`, `deleteCapability`, `upsertCapability` if not present. Keep existing imports intact.)

- [ ] **Step 4: modify `index.ts`** — wire `ctx.tools` right after building ctx and registering tools:

```ts
  ctx.tools = { getActive: () => pi.getActiveTools(), setActive: (n: string[]) => pi.setActiveTools(n) };
```

- [ ] **Step 5: modify the `session_start` handler in `index.ts`** to harvest+index tools and apply opt-in deferral:

```ts
  pi.on("session_start", async () => {
    try {
      ctx.refresh();                                   // skills (existing)
      indexTools(pi, ctx);                             // tools (new)
      if (process.env["CAP_DEFER_TOOLS"]) applyToolDeferral(pi, ctx);
    } catch { /* index is rebuildable */ }
  });
```

And add these module-level helpers in `index.ts` (below the `export default` function or above it — keep them in the same file):

```ts
function indexTools(pi: ExtensionAPI, ctx: ReturnType<typeof buildCapContext>): void {
  const caps = harvestTools(pi.getAllTools() as any);
  const fresh = new Set(caps.map((c) => c.id));
  for (const c of caps) upsertCapability(ctx.db, c);
  // prune tool rows that are no longer registered (keep skill/mcp rows)
  for (const id of allIds(ctx.db))
    if (id.startsWith("tool:") && !fresh.has(id)) deleteCapability(ctx.db, id);
}

function applyToolDeferral(pi: ExtensionAPI, ctx: ReturnType<typeof buildCapContext>): void {
  const strip = (id: string) => id.replace(/^tool:pi:/, "");
  const allToolNames = (pi.getAllTools() as any[]).map((t) => t.name);
  const deferrableNames = new Set(allIds(ctx.db).filter((id) => id.startsWith("tool:")).map(strip));
  const loadoutNames = ctx.loadouts.getActiveToolIds().map(strip);
  const sessionNames = [...ctx.sessionActive].filter((id) => id.startsWith("tool:")).map(strip);
  const keepNames = new Set([...loadoutNames, ...sessionNames]);
  const active = computeActiveToolNames({ allToolNames, deferrableNames, keepNames });
  pi.setActiveTools(active);
}
```

> Type note: `buildCapContext`'s return type is `CapContext`; you may import and annotate with `CapContext` instead of `ReturnType<...>` if cleaner. Either compiles.

- [ ] **Step 6: modify the `tool_result` handler in `index.ts`** to also record tool usage (keep the existing skill-read line):

```ts
  pi.on("tool_result", async (event: any) => {
    try {
      recordSkillReadFromEvent(ctx.db, event);                       // existing
      const tn: string = event?.toolName ?? "";
      if (tn && !ALWAYS_ACTIVE.has(tn)) recordUsage(ctx.db, `tool:pi:${tn}`); // new (visibility)
    } catch { /* best-effort */ }
  });
```
(Add `recordUsage` to the `usage.js` import alongside `recordSkillReadFromEvent`.)

- [ ] **Step 7: leave `before_agent_start` UNCHANGED.** Confirm by reading it — it must still only slim skills + append policy. (This is the ordering rule: no tool mutation here.)

- [ ] **Step 8: update `test/wiring.test.ts`** — the fake `pi` must now provide the tool methods so `session_start`/`ctx.tools` don't crash if invoked. Replace the fake pi with:

```ts
  const pi: any = {
    registerTool: (t: any) => tools.push(t.name),
    registerCommand: (n: string) => commands.push(n),
    on: (e: string) => events.push(e),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
```
Assertions unchanged (still 5 tools, commands incl. cap-status, 3 events: session_start/tool_result/before_agent_start).

- [ ] **Step 9: run full suite + tsc + smoke**

Run: `npx vitest run && npx tsc --noEmit && node scripts/smoke-load.mjs`
Expected: all tests PASS; tsc clean; `LOAD_OK` with the SAME 5 tools / 3 events (Phase 2 adds no new tool or event). The smoke loader's fake pi lacks `getAllTools` etc., but it only calls `extension(pi)` (which just registers + subscribes; the handlers aren't invoked), so it stays green — verify this is true; if `extension(pi)` now calls a tool method synchronously, add the three no-op methods to `scripts/smoke-load.mjs`'s fake pi as well.

- [ ] **Step 10: commit** `git add index.ts test/wiring.test.ts test/e2e-tools.test.ts && git commit -m "feat: wire tool harvest + opt-in deferral (session_start) + tool usage"`

---

## Definition of Done (Phase 2)

- [ ] Full suite green; `tsc` clean; jiti `LOAD_OK` (still 5 tools / 3 events).
- [ ] `capability_search({kind:"tool"})` returns other extensions' tools (e.g. `kb_*`); the always-active allowlist is absent.
- [ ] `capability_activate("tool:pi:<x>")` adds `<x>` to the active set (visible next turn).
- [ ] A `tool:` id in a loadout's `tools[]` is recognized by `getActiveToolIds`.
- [ ] **Default run:** nothing is deactivated (verify `capability_status` + that all tools remain callable).
- [ ] **`CAP_DEFER_TOOLS=1` run:** non-loadout deferrable tools are deactivated at session start; base + `capability_*` + loadout tools remain; activating one via search→activate brings it back next turn.
- [ ] Manual: with deferral on, confirm the agent can still `capability_search`/`capability_activate` (those are always-active) to recover any deferred tool.

**Follow-on:** Phase 3 (MCP) — adopt `pi-mcp-adapter`, index its cache, add `McpActivator`; gated by the runtime-promotion feasibility check (spec §10).

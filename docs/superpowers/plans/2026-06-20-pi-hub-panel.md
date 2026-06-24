# Pi Agent Hub Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pi-vscode activity-bar sidebar with a single tabbed editor-area WebView ("Pi Agent Hub", Svelte 5 + Vite) hosting Library / Skills / Tools / Loadouts tabs, fed live by an extended pi-bridge protocol.

**Architecture:** pi-bridge (agent-side WS server) gains a direct-YAML loadout gateway, a `tool_toggle` handler, and a path-allow-listed `read_file`. pi-vscode (client) gains `PiHubStore` (aggregates bridge events into one `HubState`) and `PiHubPanel` (WebviewPanel that inlines the built Svelte app and routes messages). The Svelte app renders four tabs over `postMessage`.

**Tech Stack:** TypeScript, `ws`, `yaml`, `better-sqlite3` (existing), VS Code Extension API, Svelte 5, Vite 6, vitest.

## Global Constraints

- Loadout YAML lives at `~/.pi/capabilities/loadouts.yaml`, shape `{ core: string[], active: string, loadouts: Record<string, Loadout> }`; `Loadout = { name, description, skills: string[], tools: string[], mcp: string[] }`. Cap IDs: `skill:<name>`, `tool:pi:<name>`, `mcp:<...>`.
- `read_file` MUST enforce a path allow-list: real resolved path under `~/.pi/skills/`, `~/.pi/kb/`, or `~/.pi/capabilities/` only; reject `..`/symlink escape; never return out-of-root contents.
- WebView CSP: `default-src 'none'; img-src {cspSource} data:; style-src {cspSource} 'unsafe-inline'; script-src 'nonce-{nonce}';` — fresh nonce per load, no external network.
- pi extensions run via jiti (no build step); pi-bridge uses ESM `.js` import specifiers for local files.
- Keep `bridge.ts`, `store.ts`, `terminal.ts`, `statusBar.ts`, `commands.ts`, `diff.ts`, `sessionManager.ts`, `correlate.ts`, `registry.ts`. Delete only `src/sidebar/*`.
- Commit after every task. Run the task's `verify` before committing.
- Reference spec: `docs/superpowers/specs/2026-06-20-pi-hub-panel-redesign.md`.

---

### Task 1: Loadout gateway (agent-side)

**Files:**
- Create: `agent/extensions/pi-bridge/loadoutGateway.ts`
- Test: `agent/extensions/pi-bridge/test/loadoutGateway.test.ts`

**Interfaces:**
- Produces: `class LoadoutGateway { constructor(file: string); list(): Loadout[]; get(name: string): Loadout | null; create(name: string, init?: Partial<Loadout>): void; update(name: string, patch: Partial<Loadout>): void; remove(name: string): void; addCap(name: string, capId: string): void; removeCap(name: string, capId: string): void; setActive(name: string): void; getActive(): string; snapshot(): { loadouts: Loadout[]; active: string } }` and `interface Loadout { name: string; description: string; skills: string[]; tools: string[]; mcp: string[] }`.

- [ ] **Step 1: Write the failing test**

```typescript
// agent/extensions/pi-bridge/test/loadoutGateway.test.ts
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoadoutGateway } from "../loadoutGateway.js";

function tmpFile() { return join(mkdtempSync(join(tmpdir(), "lg-")), "loadouts.yaml"); }

test("absent file yields empty snapshot with active=base", () => {
  const g = new LoadoutGateway(tmpFile());
  expect(g.snapshot()).toEqual({ loadouts: [], active: "base" });
});

test("create/update/addCap/removeCap/setActive round-trip", () => {
  const g = new LoadoutGateway(tmpFile());
  g.create("dev", { description: "dev set" });
  g.addCap("dev", "skill:brainstorming");
  g.addCap("dev", "tool:pi:read");
  g.addCap("dev", "mcp:foo");
  g.setActive("dev");
  const snap = g.snapshot();
  expect(snap.active).toBe("dev");
  const dev = snap.loadouts.find((l) => l.name === "dev")!;
  expect(dev.skills).toEqual(["skill:brainstorming"]);
  expect(dev.tools).toEqual(["tool:pi:read"]);
  expect(dev.mcp).toEqual(["mcp:foo"]);
  g.removeCap("dev", "tool:pi:read");
  expect(g.get("dev")!.tools).toEqual([]);
  g.remove("dev");
  expect(g.get("dev")).toBeNull();
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd agent/extensions/pi-bridge && npx vitest run test/loadoutGateway.test.ts`
Expected: FAIL — cannot find `../loadoutGateway.js`.

- [ ] **Step 3: Implement the gateway**

```typescript
// agent/extensions/pi-bridge/loadoutGateway.ts
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface Loadout {
  name: string; description: string;
  skills: string[]; tools: string[]; mcp: string[];
}
interface FileShape { core: string[]; active: string; loadouts: Record<string, Loadout>; }

export class LoadoutGateway {
  constructor(private file: string) {}

  private read(): FileShape {
    if (!fs.existsSync(this.file)) return { core: [], active: "base", loadouts: {} };
    try {
      const d = parse(fs.readFileSync(this.file, "utf-8")) ?? {};
      return { core: d.core ?? [], active: d.active ?? "base", loadouts: d.loadouts ?? {} };
    } catch { return { core: [], active: "base", loadouts: {} }; }
  }
  private write(d: FileShape): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, stringify(d));
  }
  private blank(name: string, init: Partial<Loadout> = {}): Loadout {
    return { name, description: init.description ?? "",
      skills: init.skills ?? [], tools: init.tools ?? [], mcp: init.mcp ?? [] };
  }

  list(): Loadout[] { return Object.values(this.read().loadouts); }
  get(name: string): Loadout | null { return this.read().loadouts[name] ?? null; }
  getActive(): string { return this.read().active; }
  snapshot(): { loadouts: Loadout[]; active: string } {
    const d = this.read();
    return { loadouts: Object.values(d.loadouts), active: d.active };
  }
  create(name: string, init: Partial<Loadout> = {}): void {
    const d = this.read(); d.loadouts[name] = this.blank(name, init); this.write(d);
  }
  update(name: string, patch: Partial<Loadout>): void {
    const d = this.read(); const cur = d.loadouts[name]; if (!cur) return;
    const next = { ...cur, ...patch, name: patch.name ?? cur.name };
    if (patch.name && patch.name !== name) delete d.loadouts[name];
    d.loadouts[next.name] = next; this.write(d);
  }
  addCap(name: string, capId: string): void {
    const d = this.read(); const lo = d.loadouts[name]; if (!lo) return;
    const list = capId.startsWith("mcp:") ? lo.mcp : capId.startsWith("tool:") ? lo.tools : lo.skills;
    if (!list.includes(capId)) list.push(capId);
    this.write(d);
  }
  removeCap(name: string, capId: string): void {
    const d = this.read(); const lo = d.loadouts[name]; if (!lo) return;
    lo.skills = lo.skills.filter((x) => x !== capId);
    lo.tools = lo.tools.filter((x) => x !== capId);
    lo.mcp = lo.mcp.filter((x) => x !== capId);
    this.write(d);
  }
  remove(name: string): void { const d = this.read(); delete d.loadouts[name]; this.write(d); }
  setActive(name: string): void { const d = this.read(); d.active = name; this.write(d); }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd agent/extensions/pi-bridge && npx vitest run test/loadoutGateway.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-bridge/loadoutGateway.ts agent/extensions/pi-bridge/test/loadoutGateway.test.ts
git commit -m "feat(pi-bridge): add LoadoutGateway (direct YAML CRUD)"
```

**verify:** `cd agent/extensions/pi-bridge && npx vitest run test/loadoutGateway.test.ts`

---

### Task 2: read_file path allow-list (agent-side)

**Files:**
- Create: `agent/extensions/pi-bridge/safeRead.ts`
- Test: `agent/extensions/pi-bridge/test/safeRead.test.ts`

**Interfaces:**
- Produces: `function safeReadFile(rawPath: string, roots: string[]): { ok: true; content: string } | { ok: false; error: string }`. Default roots in the handler (Task 3) are `[~/.pi/skills, ~/.pi/kb, ~/.pi/capabilities]`.

- [ ] **Step 1: Write the failing test**

```typescript
// agent/extensions/pi-bridge/test/safeRead.test.ts
import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeReadFile } from "../safeRead.js";

test("reads a file inside an allowed root", () => {
  const root = mkdtempSync(join(tmpdir(), "sr-"));
  const f = join(root, "skills", "a.md");
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(f, "# hi");
  const r = safeReadFile(f, [join(root, "skills")]);
  expect(r).toEqual({ ok: true, content: "# hi" });
});

test("rejects traversal outside the root", () => {
  const root = mkdtempSync(join(tmpdir(), "sr-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  const r = safeReadFile(join(root, "skills", "..", "secret.txt"), [join(root, "skills")]);
  expect(r.ok).toBe(false);
});

test("rejects a path under no allowed root", () => {
  const r = safeReadFile(join(tmpdir(), "nope.txt"), [join(tmpdir(), "skills")]);
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd agent/extensions/pi-bridge && npx vitest run test/safeRead.test.ts`
Expected: FAIL — cannot find `../safeRead.js`.

- [ ] **Step 3: Implement safeReadFile**

```typescript
// agent/extensions/pi-bridge/safeRead.ts
import fs from "node:fs";
import path from "node:path";

export function safeReadFile(
  rawPath: string, roots: string[],
): { ok: true; content: string } | { ok: false; error: string } {
  let real: string;
  try { real = fs.realpathSync(path.resolve(rawPath)); }
  catch { return { ok: false, error: "path does not exist" }; }
  const inRoot = roots.some((r) => {
    const root = path.resolve(r);
    const rel = path.relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!inRoot) return { ok: false, error: "path outside allowed roots" };
  try { return { ok: true, content: fs.readFileSync(real, "utf-8") }; }
  catch { return { ok: false, error: "read failed" }; }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd agent/extensions/pi-bridge && npx vitest run test/safeRead.test.ts`
Expected: PASS (3 tests). Note: traversal test passes because `realpathSync` collapses `..` then root-check fails.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-bridge/safeRead.ts agent/extensions/pi-bridge/test/safeRead.test.ts
git commit -m "feat(pi-bridge): add path-allow-listed safeReadFile"
```

**verify:** `cd agent/extensions/pi-bridge && npx vitest run test/safeRead.test.ts`

---

### Task 3: Bridge protocol + handlers (agent-side)

**Files:**
- Modify: `agent/extensions/pi-bridge/protocol.ts`
- Modify: `agent/extensions/pi-bridge/index.ts`

**Interfaces:**
- Consumes: `LoadoutGateway` (Task 1), `safeReadFile` (Task 2).
- Produces: WS message contract — inbound `loadout_list|loadout_create|loadout_delete|loadout_update|loadout_activate|tool_toggle|read_file`; outbound `loadouts {loadouts, active}`, `file_content {path, content}`. Reuses the existing `{ type:"response", id, data }` reply for request/reply messages.

- [ ] **Step 1: Extend protocol.ts**

Add to the `PiToVSCode` union:
```typescript
  | { type: "loadouts"; data: { loadouts: Loadout[]; active: string } }
  | { type: "file_content"; data: { path: string; content: string } }
```
Add `import type { Loadout } from "./loadoutGateway.js";` at the top.
Add to the `VSCodeToPi` union (all reply-bearing carry an `id`):
```typescript
  | { type: "loadout_list"; id: string }
  | { type: "loadout_create"; id: string; data: { name: string; description?: string; skills?: string[]; tools?: string[] } }
  | { type: "loadout_delete"; id: string; data: { name: string } }
  | { type: "loadout_update"; id: string; data: { name: string; description?: string; skills?: string[]; tools?: string[] } }
  | { type: "loadout_activate"; id: string; data: { name: string } }
  | { type: "tool_toggle"; id: string; data: { name: string; active: boolean } }
  | { type: "read_file"; id: string; data: { path: string } }
```

- [ ] **Step 2: Wire the gateway + roots in index.ts**

Near the top of the extension factory (where other dirs like `SKILLS_DIR`, `KB_DIR` are defined), add:
```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { LoadoutGateway } from "./loadoutGateway.js";
import { safeReadFile } from "./safeRead.js";

const PI_HOME = join(homedir(), ".pi");
const CAP_DIR = join(PI_HOME, "capabilities");
const LOADOUTS_YAML = join(CAP_DIR, "loadouts.yaml");
const READ_ROOTS = [join(PI_HOME, "skills"), join(PI_HOME, "kb"), CAP_DIR];
const loadouts = new LoadoutGateway(LOADOUTS_YAML);
```
(Adapt the imports to the file's existing import grouping; `SKILLS_DIR`/`KB_DIR` already resolve under `~/.pi` — reuse their base if defined.)

- [ ] **Step 3: Add inbound handlers**

In the WS `message` handler `switch (msg.type)` (where `fork`/`resume`/`command` are handled), add cases. Each replies via the existing `server.reply(msg.id, data)` / `{ type:"response", id, data }` mechanism — match the file's existing reply helper:
```typescript
case "loadout_list":
  reply(msg.id, loadouts.snapshot());
  break;
case "loadout_create":
  loadouts.create(msg.data.name, msg.data);
  reply(msg.id, loadouts.snapshot());
  server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
  break;
case "loadout_update":
  loadouts.update(msg.data.name, msg.data);
  reply(msg.id, loadouts.snapshot());
  server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
  break;
case "loadout_delete":
  loadouts.remove(msg.data.name);
  reply(msg.id, loadouts.snapshot());
  server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
  break;
case "loadout_activate":
  loadouts.setActive(msg.data.name);
  reply(msg.id, loadouts.snapshot());
  server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
  break;
case "tool_toggle": {
  const cur = new Set(pi.getActiveTools());
  if (msg.data.active) cur.add(msg.data.name); else cur.delete(msg.data.name);
  pi.setActiveTools([...cur]);
  reply(msg.id, { ok: true });
  buildAndBroadcastCapabilities();
  break;
}
case "read_file": {
  const r = safeReadFile(msg.data.path, READ_ROOTS);
  if (r.ok) reply(msg.id, { path: msg.data.path, content: r.content });
  else reply(msg.id, { path: msg.data.path, error: r.error });
  break;
}
```
If the file has no `reply(id, data)` helper, add one: `const reply = (id: string, data: unknown) => server.broadcast({ type: "response", id, data });` (broadcast is acceptable — the client matches by `id`).

- [ ] **Step 4: Broadcast loadouts on session_start**

In the `pi.on("session_start", ...)` handler, after the existing `buildAndBroadcastCapabilities()` call, add:
```typescript
    server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
```

- [ ] **Step 5: Typecheck**

Run: `cd agent/extensions/pi-bridge && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-bridge/protocol.ts agent/extensions/pi-bridge/index.ts
git commit -m "feat(pi-bridge): handle loadout CRUD, tool_toggle, read_file; broadcast loadouts"
```

**verify:** `cd agent/extensions/pi-bridge && npx tsc --noEmit`

---

### Task 4: Sidebar teardown (extension-side)

**Files:**
- Delete: `pi-vscode/src/sidebar/sessions.ts`, `files.ts`, `capabilities.ts`, `stats.ts`
- Modify: `pi-vscode/src/extension.ts`
- Modify: `pi-vscode/package.json`

**Interfaces:**
- Produces: an `extension.ts` that compiles with the sidebar registrations removed and the `pi.openHub` command stubbed (real wiring in Task 7).

- [ ] **Step 1: Remove sidebar contributions from package.json**

In `pi-vscode/package.json`: delete the `pi-sidebar` entry under `contributes.viewsContainers.activitybar`; delete the whole `contributes.views` object; delete `contributes.menus` entries whose `when` references `pi-sessions`/`pi-files`/`pi-capabilities`/`pi-stats`. In `activationEvents`, remove the four `onView:*` lines and add `"onCommand:pi.openHub"`. Add to `contributes.commands`:
```json
{ "command": "pi.openHub", "title": "pi: Open Agent Hub", "icon": "$(hubot)" },
{ "command": "pi.hub.refresh", "title": "pi: Refresh Hub", "icon": "$(refresh)" }
```
Add a keybinding block:
```json
"keybindings": [
  { "command": "pi.openHub", "key": "ctrl+shift+alt+p" }
]
```

- [ ] **Step 2: Delete the sidebar files**

```bash
git rm pi-vscode/src/sidebar/sessions.ts pi-vscode/src/sidebar/files.ts pi-vscode/src/sidebar/capabilities.ts pi-vscode/src/sidebar/stats.ts
```

- [ ] **Step 3: Prune extension.ts**

Remove the `import` lines for `SessionsProvider`, `FilesProvider`, `CapabilitiesProvider`, `StatsProvider` and the `context.subscriptions.push(...)` block that registers the four views. Add a temporary stub command so the manifest stays valid:
```typescript
  context.subscriptions.push(
    vscode.commands.registerCommand("pi.openHub", () => {
      vscode.window.showInformationMessage("pi Hub: wiring pending (Task 7)");
    }),
  );
```
Keep `registerCommands`, the status bar, diff provider, `pi.start`/`pi.connect`/`pi.refresh`, and `manager.start()`.

- [ ] **Step 4: Typecheck**

Run: `cd pi-vscode && npx tsc -p tsconfig.json --noEmit`
Expected: no errors (no dangling references to deleted providers).

- [ ] **Step 5: Commit**

```bash
git add -A pi-vscode/src pi-vscode/package.json
git commit -m "refactor(pi-vscode): remove activity-bar sidebar; stub pi.openHub"
```

**verify:** `cd pi-vscode && npx tsc -p tsconfig.json --noEmit`

---

### Task 5: HubState types + bridge events (extension-side)

**Files:**
- Modify: `pi-vscode/src/types.ts`
- Modify: `pi-vscode/src/bridge.ts`

**Interfaces:**
- Produces: `interface Loadout`, `interface HubState`, bridge events `loadouts` and `fileContent`, and typed request helpers on `PiBridge`.

- [ ] **Step 1: Add types to types.ts**

```typescript
export interface Loadout {
  name: string; description: string;
  skills: string[]; tools: string[]; mcp: string[];
}

export interface HubState {
  connected: boolean;
  collections: KBDocCollection[];
  skills: SkillEntry[];
  tools: ToolEntry[];
  loadouts: Loadout[];
  activeLoadout: string | null;
  docContents: Record<string, string>;
}
```

- [ ] **Step 2: Add events to bridge.ts**

In `handleMessage`'s switch add:
```typescript
      case "loadouts": this.emit("loadouts", msg.data as { loadouts: Loadout[]; active: string }); break;
      case "file_content": this.emit("fileContent", msg.data as { path: string; content?: string; error?: string }); break;
```
Add to `PiBridgeEvents`:
```typescript
  loadouts: [data: { loadouts: Loadout[]; active: string }];
  fileContent: [data: { path: string; content?: string; error?: string }];
```
Import `Loadout` from `./types`.

- [ ] **Step 3: Add typed request helpers to bridge.ts**

```typescript
  listLoadouts() { return this.send({ type: "loadout_list" }) as Promise<{ loadouts: Loadout[]; active: string }>; }
  activateLoadout(name: string) { return this.send({ type: "loadout_activate", data: { name } }); }
  createLoadout(data: { name: string; description?: string; skills?: string[]; tools?: string[] }) { return this.send({ type: "loadout_create", data }); }
  updateLoadout(data: { name: string; description?: string; skills?: string[]; tools?: string[] }) { return this.send({ type: "loadout_update", data }); }
  deleteLoadout(name: string) { return this.send({ type: "loadout_delete", data: { name } }); }
  toggleTool(name: string, active: boolean) { return this.send({ type: "tool_toggle", data: { name, active } }); }
  readFile(path: string) { return this.send({ type: "read_file", data: { path } }) as Promise<{ path: string; content?: string; error?: string }>; }
```

- [ ] **Step 4: Typecheck**

Run: `cd pi-vscode && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add pi-vscode/src/types.ts pi-vscode/src/bridge.ts
git commit -m "feat(pi-vscode): HubState/Loadout types + loadout/file bridge requests"
```

**verify:** `cd pi-vscode && npx tsc -p tsconfig.json --noEmit`

---

### Task 6: PiHubStore (extension-side)

**Files:**
- Create: `pi-vscode/src/hub/PiHubStore.ts`
- Test: `pi-vscode/src/hub/PiHubStore.test.ts`
- Modify: `pi-vscode/package.json` (add `vitest` devDep + `test` script if absent)

**Interfaces:**
- Consumes: `PiBridge` events (`capabilities`, `loadouts`, `fileContent`, `connected`, `disconnected`), `HubState` (Task 5).
- Produces: `class PiHubStore extends EventEmitter { constructor(bridge: PiBridge); get state(): HubState; on("changed", cb): this }`. Emits `changed` (debounced 50 ms) only when the serialized state differs.

- [ ] **Step 1: Write the failing test**

```typescript
// pi-vscode/src/hub/PiHubStore.test.ts
import { test, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PiHubStore } from "./PiHubStore";

test("aggregates capabilities + loadouts into HubState and emits changed", async () => {
  vi.useFakeTimers();
  const bridge = new EventEmitter() as any;
  bridge.isConnected = () => true;
  const store = new PiHubStore(bridge);
  const changed = vi.fn();
  store.on("changed", changed);
  bridge.emit("capabilities", { tools: [{ name: "read", description: "", source: "builtin", sourcePath: "", isActive: true }], skills: [], kBCollections: [], activeTools: ["read"], activeSkills: [] });
  bridge.emit("loadouts", { loadouts: [{ name: "dev", description: "", skills: [], tools: [], mcp: [] }], active: "dev" });
  await vi.advanceTimersByTimeAsync(60);
  expect(changed).toHaveBeenCalled();
  expect(store.state.tools[0].name).toBe("read");
  expect(store.state.activeLoadout).toBe("dev");
  vi.useRealTimers();
});

test("does not emit changed when state is unchanged", async () => {
  vi.useFakeTimers();
  const bridge = new EventEmitter() as any;
  bridge.isConnected = () => true;
  const store = new PiHubStore(bridge);
  bridge.emit("capabilities", { tools: [], skills: [], kBCollections: [], activeTools: [], activeSkills: [] });
  await vi.advanceTimersByTimeAsync(60);
  const changed = vi.fn();
  store.on("changed", changed);
  bridge.emit("capabilities", { tools: [], skills: [], kBCollections: [], activeTools: [], activeSkills: [] });
  await vi.advanceTimersByTimeAsync(60);
  expect(changed).not.toHaveBeenCalled();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd pi-vscode && npx vitest run src/hub/PiHubStore.test.ts`
Expected: FAIL — cannot find `./PiHubStore`. (If `vitest` is missing: `npm i -D vitest` first and add `"test": "vitest run"` to `scripts`.)

- [ ] **Step 3: Implement PiHubStore**

```typescript
// pi-vscode/src/hub/PiHubStore.ts
import { EventEmitter } from "node:events";
import type { PiBridge } from "../bridge";
import type { HubState } from "../types";

export class PiHubStore extends EventEmitter {
  private _state: HubState = {
    connected: false, collections: [], skills: [], tools: [],
    loadouts: [], activeLoadout: null, docContents: {},
  };
  private lastJson = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private bridge: PiBridge) {
    super();
    this._state.connected = bridge.isConnected();
    bridge.on("connected", () => { this._state.connected = true; this.schedule(); });
    bridge.on("disconnected", () => { this._state.connected = false; this.schedule(); });
    bridge.on("capabilities", (c) => {
      this._state.tools = c.tools; this._state.skills = c.skills;
      this._state.collections = c.kBCollections; this.schedule();
    });
    bridge.on("loadouts", (d) => {
      this._state.loadouts = d.loadouts; this._state.activeLoadout = d.active; this.schedule();
    });
    bridge.on("fileContent", (d) => {
      if (d.content !== undefined) { this._state.docContents[d.path] = d.content; this.schedule(); }
    });
  }

  get state(): HubState { return this._state; }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const json = JSON.stringify(this._state);
      if (json === this.lastJson) return;
      this.lastJson = json;
      this.emit("changed", this._state);
    }, 50);
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd pi-vscode && npx vitest run src/hub/PiHubStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add pi-vscode/src/hub/PiHubStore.ts pi-vscode/src/hub/PiHubStore.test.ts pi-vscode/package.json
git commit -m "feat(pi-vscode): PiHubStore aggregates bridge events into HubState"
```

**verify:** `cd pi-vscode && npx vitest run src/hub/PiHubStore.test.ts`

---

### Task 7: PiHubPanel + extension wiring (extension-side)

**Files:**
- Create: `pi-vscode/src/hub/PiHubPanel.ts`
- Modify: `pi-vscode/src/extension.ts`

**Interfaces:**
- Consumes: `PiHubStore` (Task 6), `PiBridge` request helpers (Task 5), the built `hub-dist/index.html` (Task 8).
- Produces: `class PiHubPanel { constructor(context: vscode.ExtensionContext, bridge: PiBridge, store: PiHubStore); show(): void }`. Inbound webview message contract (from the Svelte app): `{ type: "ready" }`, `{ type: "readFile", path }`, `{ type: "toggleTool", name, active }`, `{ type: "activateLoadout", name }`, `{ type: "createLoadout", ...}`, `{ type: "updateLoadout", ...}`, `{ type: "deleteLoadout", name }`, `{ type: "openInEditor", path }`, `{ type: "revealDir", path }`, `{ type: "persistUi", ui }`. Outbound to webview: `{ type: "state", data: HubState }`.

- [ ] **Step 1: Implement PiHubPanel**

```typescript
// pi-vscode/src/hub/PiHubPanel.ts
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PiBridge } from "../bridge";
import type { PiHubStore } from "./PiHubStore";

export class PiHubPanel {
  private panel: vscode.WebviewPanel | null = null;
  private distRoot: vscode.Uri;

  constructor(
    private context: vscode.ExtensionContext,
    private bridge: PiBridge,
    private store: PiHubStore,
  ) {
    this.distRoot = vscode.Uri.joinPath(context.extensionUri, "hub-dist");
    store.on("changed", () => this.post());
  }

  show(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); return; }
    this.panel = vscode.window.createWebviewPanel(
      "piHub", "Pi Agent Hub", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.distRoot] },
    );
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => { this.panel = null; });
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  private post(): void {
    this.panel?.webview.postMessage({ type: "state", data: this.store.state });
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case "ready": this.post(); break;
      case "readFile": await this.bridge.readFile(m.path); break; // store fills via fileContent event
      case "toggleTool": await this.bridge.toggleTool(m.name, m.active); break;
      case "activateLoadout": await this.bridge.activateLoadout(m.name); break;
      case "createLoadout": await this.bridge.createLoadout(m.data); break;
      case "updateLoadout": await this.bridge.updateLoadout(m.data); break;
      case "deleteLoadout": await this.bridge.deleteLoadout(m.name); break;
      case "openInEditor":
        vscode.workspace.openTextDocument(vscode.Uri.file(m.path))
          .then((d) => vscode.window.showTextDocument(d)); break;
      case "revealDir":
        vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(m.path)); break;
      case "persistUi": this.context.workspaceState.update("piHub.ui", m.ui); break;
    }
  }

  private html(webview: vscode.Webview): string {
    const indexPath = join(this.distRoot.fsPath, "index.html");
    let html = readFileSync(indexPath, "utf-8");
    const nonce = Array.from({ length: 24 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
    // Rewrite ./assets refs to webview URIs (Vite emits relative paths with base "./").
    html = html.replace(/(src|href)="\.?\/?(assets\/[^"]+)"/g, (_m, attr, p) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(this.distRoot, p));
      return `${attr}="${uri}"`;
    });
    // Add nonce to every <script> and inject CSP + initial UI state.
    html = html.replace(/<script/g, `<script nonce="${nonce}"`);
    const ui = JSON.stringify(this.context.workspaceState.get("piHub.ui") ?? {});
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<script nonce="${nonce}">window.__PI_HUB_UI__=${ui};</script>`;
    return html.replace("<head>", `<head>${head}`);
  }
}
```

- [ ] **Step 2: Wire into extension.ts**

Replace the Task-4 stub. Add imports and construct the store + panel after `bridge`/`store` exist. The hub needs the live `PiBridge`; obtain it from `SessionManager` (the active session's bridge). If `SessionManager` exposes the active bridge as `manager.activeBridge` or via the view store, use that; otherwise add a getter `get bridge(): PiBridge | null` on `SessionManager` returning the active session's bridge. Then:
```typescript
import { PiHubStore } from "./hub/PiHubStore";
import { PiHubPanel } from "./hub/PiHubPanel";
// ... inside activate, after manager/store:
let hubPanel: PiHubPanel | null = null;
context.subscriptions.push(
  vscode.commands.registerCommand("pi.openHub", () => {
    const bridge = manager.activeBridge;
    if (!bridge) { vscode.window.showWarningMessage("pi: no active session. Run pi: Connect first."); return; }
    if (!hubPanel) hubPanel = new PiHubPanel(context, bridge, new PiHubStore(bridge));
    hubPanel.show();
  }),
  vscode.commands.registerCommand("pi.hub.refresh", () => manager.refreshNow()),
);
```
If `SessionManager` has no `activeBridge` getter, add one in `sessionManager.ts` exposing the active session's `PiBridge` instance.

- [ ] **Step 3: Typecheck**

Run: `cd pi-vscode && npx tsc -p tsconfig.json --noEmit`
Expected: no errors. (Will fail at runtime until `hub-dist/` exists — built in Task 8 — but typecheck passes.)

- [ ] **Step 4: Commit**

```bash
git add pi-vscode/src/hub/PiHubPanel.ts pi-vscode/src/extension.ts pi-vscode/src/sessionManager.ts
git commit -m "feat(pi-vscode): PiHubPanel webview wrapper + pi.openHub wiring"
```

**verify:** `cd pi-vscode && npx tsc -p tsconfig.json --noEmit`

---

### Task 8: Svelte hub-app scaffold + build wiring

**Files:**
- Create: `pi-vscode/hub-app/package.json`, `vite.config.ts`, `svelte.config.js`, `tsconfig.json`, `index.html`, `src/main.ts`, `src/App.svelte`
- Create: `pi-vscode/hub-app/src/lib/bridge.ts`, `src/lib/types.ts`, `src/lib/theme.css`
- Modify: `pi-vscode/package.json` (build chain), `pi-vscode/.vscodeignore`

**Interfaces:**
- Produces: a build that outputs `pi-vscode/hub-dist/index.html` (single inlined bundle). `lib/bridge.ts` exports `vscodeApi`, `onState(cb)`, `post(msg)`. `lib/types.ts` mirrors `HubState`/`Loadout`/`ToolEntry`/`SkillEntry`/`KBDocCollection`.

- [ ] **Step 1: Create hub-app package + config**

`hub-app/package.json`:
```json
{
  "name": "pi-hub-app", "private": true, "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "svelte": "^5.0.0", "svelte-check": "^4.0.0",
    "typescript": "^5.7.0", "vite": "^6.0.0"
  }
}
```
`hub-app/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  build: {
    outDir: "../hub-dist", emptyOutDir: true,
    rollupOptions: { output: { manualChunks: undefined, inlineDynamicImports: true } },
  },
});
```
`hub-app/svelte.config.js`:
```javascript
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
export default { preprocess: vitePreprocess() };
```
`hub-app/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "verbatimModuleSyntax": true, "isolatedModules": true,
    "skipLibCheck": true, "types": ["svelte"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```
`hub-app/index.html`:
```html
<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Pi Agent Hub</title></head>
<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>
```

- [ ] **Step 2: Create lib + App shell**

`hub-app/src/lib/types.ts` — copy `Loadout`, `ToolEntry`, `SkillEntry`, `KBDocEntry`, `KBDocCollection`, `HubState` from `pi-vscode/src/types.ts` (structural mirror).
`hub-app/src/lib/bridge.ts`:
```typescript
import type { HubState } from "./types";
const vscode = (window as any).acquireVsCodeApi?.() ?? { postMessage() {}, getState() {}, setState() {} };
export const initialUi = (window as any).__PI_HUB_UI__ ?? {};
export function post(msg: unknown) { vscode.postMessage(msg); }
export function onState(cb: (s: HubState) => void) {
  window.addEventListener("message", (e) => { if (e.data?.type === "state") cb(e.data.data); });
}
export function ready() { post({ type: "ready" }); }
export function persistUi(ui: unknown) { vscode.setState(ui); post({ type: "persistUi", ui }); }
```
`hub-app/src/lib/theme.css`:
```css
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
button { font: inherit; color: var(--vscode-button-foreground);
  background: var(--vscode-button-background); border: none; border-radius: 2px;
  padding: 3px 8px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 3px 6px; }
```
`hub-app/src/main.ts`:
```typescript
import { mount } from "svelte";
import App from "./App.svelte";
import "./lib/theme.css";
const app = mount(App, { target: document.getElementById("app")! });
export default app;
```
`hub-app/src/App.svelte` (minimal shell; tabs added in Task 9):
```svelte
<script lang="ts">
  import { onState, ready } from "./lib/bridge";
  import type { HubState } from "./lib/types";
  let state = $state<HubState | null>(null);
  onState((s) => (state = s));
  ready();
</script>

<header><strong>Pi Agent Hub</strong></header>
<main>
  {#if !state}<p>Connecting…</p>
  {:else}<p>{state.connected ? "Connected" : "Offline"} · {state.tools.length} tools · {state.skills.length} skills</p>{/if}
</main>

<style>
  header { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  main { padding: 10px; }
</style>
```

- [ ] **Step 3: Wire the build into the extension**

In `pi-vscode/package.json` scripts:
```json
"compile": "npx tsc -p tsconfig.json && npm --prefix hub-app install && npm --prefix hub-app run build",
"vscode:prepublish": "npx tsc -p tsconfig.json && npm --prefix hub-app install && npm --prefix hub-app run build",
"watch": "npx tsc -watch -p tsconfig.json"
```
In `pi-vscode/.vscodeignore` add `hub-app/**` (exclude source) and ensure `hub-dist/**` is NOT ignored. Create `pi-vscode/hub-app/.gitignore` with `node_modules/` and `dist/`. Add `/hub-dist/` to `pi-vscode/.gitignore` (built artifact; rebuilt on package).

- [ ] **Step 4: Build and verify output**

Run: `cd pi-vscode && npm --prefix hub-app install && npm --prefix hub-app run build && test -f hub-dist/index.html && echo OK`
Expected: prints `OK`; `hub-dist/index.html` exists and references `./assets/*.js`.

- [ ] **Step 5: Commit**

```bash
git add pi-vscode/hub-app pi-vscode/package.json pi-vscode/.vscodeignore pi-vscode/.gitignore
git commit -m "feat(pi-vscode): scaffold Svelte hub-app + build pipeline"
```

**verify:** `cd pi-vscode && npm --prefix hub-app run build && test -f hub-dist/index.html`

---

### Task 9: TabBar + App layout + shared components

**Files:**
- Create: `pi-vscode/hub-app/src/TabBar.svelte`
- Create: `pi-vscode/hub-app/src/components/SearchBar.svelte`, `Badge.svelte`, `Dot.svelte`, `ChevronGroup.svelte`
- Modify: `pi-vscode/hub-app/src/App.svelte`

**Interfaces:**
- Consumes: `HubState`, `initialUi`, `persistUi` (Task 8).
- Produces: `App.svelte` renders a `TabBar` + the active tab's content + a footer status line. `TabBar` props: `tabs: {id,label,icon}[]`, `active: string`, `order: string[]`, callbacks `onSelect(id)`, `onReorder(order)`. `ChevronGroup` props: `id`, `title`, `count`, `collapsed`, `onToggle`. `SearchBar` props: `value`, `placeholder`, `onSearch(text)` (150 ms debounce). `Dot` prop `on: boolean`. `Badge` prop `text`.

- [ ] **Step 1: Shared components**

`components/Dot.svelte`:
```svelte
<script lang="ts">let { on = false }: { on?: boolean } = $props();</script>
<span class="dot" class:on></span>
<style>.dot{width:7px;height:7px;border-radius:50%;display:inline-block;border:1px solid var(--vscode-descriptionForeground)}
.dot.on{background:var(--vscode-charts-green,#89d185);border-color:var(--vscode-charts-green,#89d185)}</style>
```
`components/Badge.svelte`:
```svelte
<script lang="ts">let { text }: { text: string } = $props();</script>
<span class="badge">{text}</span>
<style>.badge{font-size:.8em;opacity:.7;border:1px solid var(--vscode-panel-border);border-radius:3px;padding:0 4px}</style>
```
`components/SearchBar.svelte`:
```svelte
<script lang="ts">
  let { value = "", placeholder = "Search…", onSearch }: { value?: string; placeholder?: string; onSearch: (t: string) => void } = $props();
  let t: ReturnType<typeof setTimeout>;
  function oninput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    clearTimeout(t); t = setTimeout(() => onSearch(v.toLowerCase()), 150);
  }
</script>
<input type="text" {placeholder} {value} {oninput} style="width:100%" />
```
`components/ChevronGroup.svelte`:
```svelte
<script lang="ts">
  let { id, title, count = "", collapsed = false, onToggle, children }:
    { id: string; title: string; count?: string | number; collapsed?: boolean; onToggle: (id: string) => void; children: any } = $props();
</script>
<div class="group" class:collapsed>
  <button class="head" onclick={() => onToggle(id)}>
    <span class="chev">▾</span><span>{title}</span><span class="count">{count}</span>
  </button>
  {#if !collapsed}<div class="body">{@render children()}</div>{/if}
</div>
<style>
  .group .head{display:flex;gap:4px;width:100%;align-items:center;background:transparent;color:var(--vscode-sideBarSectionHeader-foreground);text-transform:uppercase;font-size:11px;font-weight:600;padding:4px 8px}
  .group .head:hover{background:var(--vscode-list-hoverBackground)}
  .count{margin-left:auto;opacity:.7;font-weight:400}
  .chev{transition:transform .12s} .collapsed .chev{transform:rotate(-90deg)}
</style>
```

- [ ] **Step 2: TabBar with drag-to-reorder**

`TabBar.svelte`:
```svelte
<script lang="ts">
  let { tabs, active, order, onSelect, onReorder }:
    { tabs: { id: string; label: string; icon: string }[]; active: string; order: string[];
      onSelect: (id: string) => void; onReorder: (o: string[]) => void } = $props();
  let dragId = $state<string | null>(null);
  const ordered = $derived(order.map((id) => tabs.find((t) => t.id === id)!).filter(Boolean));
  function ondrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const next = [...order];
    next.splice(next.indexOf(dragId), 1);
    next.splice(next.indexOf(targetId), 0, dragId);
    dragId = null; onReorder(next);
  }
</script>
<nav class="tabbar">
  {#each ordered as t (t.id)}
    <button class="tab" class:active={t.id === active} draggable="true"
      onclick={() => onSelect(t.id)}
      ondragstart={() => (dragId = t.id)}
      ondragover={(e) => e.preventDefault()}
      ondrop={() => ondrop(t.id)}>
      {t.icon} {t.label}
    </button>
  {/each}
</nav>
<style>
  .tabbar{display:flex;gap:2px;border-bottom:1px solid var(--vscode-panel-border)}
  .tab{background:transparent;color:var(--vscode-foreground);border-radius:0;padding:6px 12px;opacity:.75}
  .tab.active{opacity:1;background:var(--vscode-tab-activeBackground);border-bottom:2px solid var(--vscode-focusBorder)}
</style>
```

- [ ] **Step 3: App layout wiring**

Rewrite `App.svelte` to host the tab system (tab bodies are placeholders until Tasks 10–13 replace them):
```svelte
<script lang="ts">
  import { onState, ready, persistUi, initialUi } from "./lib/bridge";
  import type { HubState } from "./lib/types";
  import TabBar from "./TabBar.svelte";
  let state = $state<HubState | null>(null);
  onState((s) => (state = s)); ready();
  const TABS = [
    { id: "library", label: "Library", icon: "📚" },
    { id: "skills", label: "Skills", icon: "⚡" },
    { id: "tools", label: "Tools", icon: "🛠" },
    { id: "loadouts", label: "Loadouts", icon: "📦" },
  ];
  let order = $state<string[]>(initialUi.tabOrder ?? TABS.map((t) => t.id));
  let active = $state<string>(initialUi.activeTab ?? "library");
  function save() { persistUi({ tabOrder: order, activeTab: active }); }
</script>
<TabBar tabs={TABS} {active} {order}
  onSelect={(id) => { active = id; save(); }}
  onReorder={(o) => { order = o; save(); }} />
<main>
  {#if !state}<p style="padding:10px">Connecting…</p>
  {:else}
    {#if active === "library"}<section>Library — {state.collections.length} collections</section>{/if}
    {#if active === "skills"}<section>Skills — {state.skills.length}</section>{/if}
    {#if active === "tools"}<section>Tools — {state.tools.length}</section>{/if}
    {#if active === "loadouts"}<section>Loadouts — {state.loadouts.length}</section>{/if}
  {/if}
</main>
<footer>{state?.connected ? "● connected" : "○ offline"} · active loadout: {state?.activeLoadout ?? "—"}</footer>
<style>
  main{padding:10px;overflow:auto} section{padding:6px}
  footer{position:sticky;bottom:0;padding:4px 10px;border-top:1px solid var(--vscode-panel-border);font-size:.85em;opacity:.8;background:var(--vscode-editor-background)}
</style>
```

- [ ] **Step 4: Build + svelte-check**

Run: `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json && npm run build`
Expected: 0 svelte-check errors; build writes `../hub-dist/index.html`.

- [ ] **Step 5: Commit**

```bash
git add pi-vscode/hub-app/src
git commit -m "feat(hub-app): TabBar, shared components, App tab layout"
```

**verify:** `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json`

---

### Task 10: Library tab

**Files:**
- Create: `pi-vscode/hub-app/src/tabs/LibraryTab.svelte`, `src/tabs/DocPreview.svelte`
- Modify: `pi-vscode/hub-app/src/App.svelte` (mount LibraryTab)

**Interfaces:**
- Consumes: `state.collections: KBDocCollection[]`, `state.docContents`, `post` (Task 8).
- Produces: a tab that renders the collections tree (`ChevronGroup` per collection), client-side fuzzy filter over `doc.title`+tags, a `DocPreview` pane. Doc click → `post({ type:"readFile", path: doc.filePath })`, then preview reads `state.docContents[doc.filePath]`. Buttons: `Open in Editor` → `post({ type:"openInEditor", path })`; `Copy Doc ID` → clipboard.

- [ ] **Step 1: DocPreview component**

```svelte
<!-- src/tabs/DocPreview.svelte -->
<script lang="ts">
  let { title, content, path, onOpen }:
    { title: string; content?: string; path: string; onOpen: (p: string) => void } = $props();
</script>
<div class="preview">
  <div class="hd"><strong>{title}</strong>
    <span class="sp"></span>
    <button onclick={() => onOpen(path)}>📂 Open in Editor</button>
    <button onclick={() => navigator.clipboard.writeText(path)}>🔗 Copy Doc ID</button>
  </div>
  <pre>{content ?? "Loading…"}</pre>
</div>
<style>
  .preview{border:1px solid var(--vscode-panel-border);border-radius:4px;margin-top:8px}
  .hd{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}
  .sp{flex:1} pre{margin:0;padding:8px;max-height:40vh;overflow:auto;white-space:pre-wrap}
</style>
```

- [ ] **Step 2: LibraryTab**

```svelte
<!-- src/tabs/LibraryTab.svelte -->
<script lang="ts">
  import type { HubState, KBDocEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  import SearchBar from "../components/SearchBar.svelte";
  import ChevronGroup from "../components/ChevronGroup.svelte";
  import DocPreview from "./DocPreview.svelte";
  let { state }: { state: HubState } = $props();
  let q = $state(""); let sel = $state<KBDocEntry | null>(null);
  let collapsed = $state<Record<string, boolean>>({});
  function hit(d: KBDocEntry) {
    if (!q) return true;
    return (d.title + " " + (d.tags ?? []).join(" ")).toLowerCase().includes(q);
  }
  function pick(d: KBDocEntry) { sel = d; post({ type: "readFile", path: d.filePath }); }
  const total = $derived(state.collections.reduce((n, c) => n + c.docs.filter(hit).length, 0));
</script>
<SearchBar placeholder="Search KB docs…" onSearch={(t) => (q = t)} />
<div class="count">{total} docs</div>
{#each state.collections as c (c.name)}
  {@const docs = c.docs.filter(hit)}
  {#if docs.length || !q}
    <ChevronGroup id={c.name} title={"📁 " + c.name} count={docs.length}
      collapsed={collapsed[c.name]} onToggle={(id) => (collapsed[id] = !collapsed[id])}>
      {#snippet children()}
        {#each docs as d (d.id)}
          <button class="row" onclick={() => pick(d)}>
            📄 {d.title} <span class="tags">{(d.tags ?? []).join(", ")}</span>
          </button>
        {/each}
      {/snippet}
    </ChevronGroup>
  {/if}
{/each}
{#if sel}
  <DocPreview title={sel.title} path={sel.filePath}
    content={state.docContents[sel.filePath]}
    onOpen={(p) => post({ type: "openInEditor", path: p })} />
{/if}
<style>
  .count{padding:2px 8px;opacity:.7;font-size:.85em}
  .row{display:flex;gap:6px;width:100%;background:transparent;color:var(--vscode-foreground);padding:3px 8px 3px 22px}
  .row:hover{background:var(--vscode-list-hoverBackground)}
  .tags{opacity:.6;font-size:.85em}
</style>
```

- [ ] **Step 3: Mount in App.svelte**

Replace the `{#if active === "library"}…{/if}` placeholder with `<LibraryTab {state} />` and add `import LibraryTab from "./tabs/LibraryTab.svelte";`.

- [ ] **Step 4: svelte-check + build**

Run: `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json && npm run build`
Expected: 0 errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add pi-vscode/hub-app/src
git commit -m "feat(hub-app): Library tab with tree, search, doc preview"
```

**verify:** `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json`

---

### Task 11: Skills tab

**Files:**
- Create: `pi-vscode/hub-app/src/tabs/SkillsTab.svelte`
- Modify: `pi-vscode/hub-app/src/App.svelte`

**Interfaces:**
- Consumes: `state.skills: SkillEntry[]`, `state.loadouts`, `state.activeLoadout`, `state.docContents`, `post`.
- Produces: list with `Dot` (filled = skill is a member of the active loadout via `skill:<name>` membership, else hollow), client-side filter, SKILL.md preview via `readFile`, `Open Dir` → `post({ type:"revealDir", path: dirname(filePath) })`.

- [ ] **Step 1: SkillsTab**

```svelte
<!-- src/tabs/SkillsTab.svelte -->
<script lang="ts">
  import type { HubState, SkillEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  import SearchBar from "../components/SearchBar.svelte";
  import Dot from "../components/Dot.svelte";
  let { state }: { state: HubState } = $props();
  let q = $state(""); let sel = $state<SkillEntry | null>(null);
  const activeSet = $derived(new Set(
    (state.loadouts.find((l) => l.name === state.activeLoadout)?.skills ?? []).map((id) => id.replace(/^skill:/, "")),
  ));
  function inLoadout(s: SkillEntry) { return activeSet.has(s.name) || s.isActive; }
  function hit(s: SkillEntry) { return !q || (s.name + " " + s.description).toLowerCase().includes(q); }
  function pick(s: SkillEntry) { sel = s; if (s.filePath) post({ type: "readFile", path: s.filePath }); }
  function dir(p: string) { return p.replace(/[\\/][^\\/]*$/, ""); }
  const shown = $derived(state.skills.filter(hit));
</script>
<SearchBar placeholder="Search skills…" onSearch={(t) => (q = t)} />
<div class="count">{shown.length}/{state.skills.length}</div>
{#each shown as s (s.name)}
  <button class="row" onclick={() => pick(s)}>
    <Dot on={inLoadout(s)} /> <span class="nm">{s.name}</span>
    <span class="ds">{s.description}</span>
  </button>
{/each}
{#if sel}
  <div class="preview">
    <div class="hd"><strong>{sel.name}</strong><span class="sp"></span>
      {#if sel.filePath}<button onclick={() => post({ type: "revealDir", path: dir(sel.filePath) })}>📂 Open Dir</button>{/if}
    </div>
    <pre>{state.docContents[sel.filePath] ?? "Loading…"}</pre>
  </div>
{/if}
<style>
  .count{padding:2px 8px;opacity:.7;font-size:.85em}
  .row{display:flex;gap:6px;width:100%;align-items:center;background:transparent;color:var(--vscode-foreground);padding:3px 8px}
  .row:hover{background:var(--vscode-list-hoverBackground)} .ds{opacity:.6;font-size:.9em}
  .preview{border:1px solid var(--vscode-panel-border);border-radius:4px;margin-top:8px}
  .hd{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}
  .sp{flex:1} pre{margin:0;padding:8px;max-height:40vh;overflow:auto;white-space:pre-wrap}
</style>
```

- [ ] **Step 2: Mount in App.svelte**

Replace the skills placeholder with `<SkillsTab {state} />`; add the import.

- [ ] **Step 3: svelte-check + build**

Run: `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json && npm run build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add pi-vscode/hub-app/src
git commit -m "feat(hub-app): Skills tab with loadout-membership dots + preview"
```

**verify:** `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json`

---

### Task 12: Tools tab

**Files:**
- Create: `pi-vscode/hub-app/src/tabs/ToolsTab.svelte`
- Modify: `pi-vscode/hub-app/src/App.svelte`

**Interfaces:**
- Consumes: `state.tools: ToolEntry[]`, `post`.
- Produces: filterable list (`✓` active), source `Badge`, All/Active-Only toggle, detail pane (description + pretty-printed JSON schema), toggle → `post({ type:"toggleTool", name, active: !isActive })`.

- [ ] **Step 1: ToolsTab**

```svelte
<!-- src/tabs/ToolsTab.svelte -->
<script lang="ts">
  import type { HubState, ToolEntry } from "../lib/types";
  import { post } from "../lib/bridge";
  import SearchBar from "../components/SearchBar.svelte";
  import Badge from "../components/Badge.svelte";
  let { state }: { state: HubState } = $props();
  let q = $state(""); let activeOnly = $state(false); let sel = $state<ToolEntry | null>(null);
  function hit(t: ToolEntry) {
    if (activeOnly && !t.isActive) return false;
    return !q || (t.name + " " + t.description).toLowerCase().includes(q);
  }
  const shown = $derived(state.tools.filter(hit));
</script>
<div class="bar">
  <SearchBar placeholder="Filter tools…" onSearch={(t) => (q = t)} />
  <label><input type="checkbox" bind:checked={activeOnly} /> Active only</label>
</div>
{#each shown as t (t.name)}
  <button class="row" class:on={t.isActive} onclick={() => (sel = t)}>
    <span class="ck">{t.isActive ? "✓" : "○"}</span>
    <span class="nm">{t.name}</span><span class="ds">{t.description}</span>
    <Badge text={t.source} />
  </button>
{/each}
{#if sel}
  <div class="preview">
    <strong>{sel.name}</strong>
    <p>{sel.description}</p>
    <div>Source: <Badge text={sel.source} /></div>
    <pre>{JSON.stringify(sel.schema ?? {}, null, 2)}</pre>
    <button onclick={() => post({ type: "toggleTool", name: sel!.name, active: !sel!.isActive })}>
      {sel.isActive ? "Toggle Off" : "Toggle On"}
    </button>
  </div>
{/if}
<style>
  .bar{display:flex;gap:8px;align-items:center;padding:4px 0} label{font-size:.85em;white-space:nowrap}
  .row{display:flex;gap:6px;width:100%;align-items:center;background:transparent;color:var(--vscode-foreground);padding:3px 8px;opacity:.7}
  .row.on{opacity:1} .row:hover{background:var(--vscode-list-hoverBackground)}
  .ds{flex:1;opacity:.6;font-size:.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .preview{border:1px solid var(--vscode-panel-border);border-radius:4px;margin-top:8px;padding:8px}
  pre{max-height:30vh;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:6px;border-radius:3px}
</style>
```

- [ ] **Step 2: Mount in App.svelte**

Replace the tools placeholder with `<ToolsTab {state} />`; add the import.

- [ ] **Step 3: svelte-check + build**

Run: `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json && npm run build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add pi-vscode/hub-app/src
git commit -m "feat(hub-app): Tools tab with filter, schema detail, toggle"
```

**verify:** `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json`

---

### Task 13: Loadouts tab

**Files:**
- Create: `pi-vscode/hub-app/src/tabs/LoadoutTab.svelte`
- Modify: `pi-vscode/hub-app/src/App.svelte`

**Interfaces:**
- Consumes: `state.loadouts: Loadout[]`, `state.activeLoadout`, `state.skills`, `state.tools`, `post`.
- Produces: loadout list (active marked), member view (skills/tools by cap-id), actions: Activate → `post({type:"activateLoadout",name})`; New → prompt name → `createLoadout`; Duplicate → `createLoadout` with copied arrays; Delete → `deleteLoadout`; Edit → toggle a skill/tool membership → `updateLoadout` with new arrays.

- [ ] **Step 1: LoadoutTab**

```svelte
<!-- src/tabs/LoadoutTab.svelte -->
<script lang="ts">
  import type { HubState, Loadout } from "../lib/types";
  import { post } from "../lib/bridge";
  let { state }: { state: HubState } = $props();
  let selName = $state<string | null>(null);
  let editing = $state(false);
  const sel = $derived(state.loadouts.find((l) => l.name === selName) ?? null);
  function activate(n: string) { post({ type: "activateLoadout", name: n }); }
  function create() {
    const name = prompt("New loadout name:")?.trim(); if (!name) return;
    post({ type: "createLoadout", data: { name } }); selName = name;
  }
  function duplicate(l: Loadout) {
    const name = prompt("Duplicate as:", l.name + "-copy")?.trim(); if (!name) return;
    post({ type: "createLoadout", data: { name, description: l.description, skills: l.skills, tools: l.tools } });
  }
  function del(n: string) { if (confirm(`Delete loadout "${n}"?`)) { post({ type: "deleteLoadout", name: n }); selName = null; } }
  function toggleSkill(l: Loadout, capId: string) {
    const skills = l.skills.includes(capId) ? l.skills.filter((x) => x !== capId) : [...l.skills, capId];
    post({ type: "updateLoadout", data: { name: l.name, skills, tools: l.tools } });
  }
</script>
<div class="hd">Active: <strong>{state.activeLoadout ?? "—"}</strong>
  <span class="sp"></span><button onclick={create}>➕ New Loadout</button></div>
<ul class="list">
  {#each state.loadouts as l (l.name)}
    <li class:sel={l.name === selName}>
      <button class="pick" onclick={() => (selName = l.name)}>
        {l.name === state.activeLoadout ? "●" : "○"} {l.name}
        <span class="ct">{l.skills.length} skills</span>
      </button>
      <button onclick={() => activate(l.name)}>Activate</button>
      <button onclick={() => duplicate(l)}>Duplicate</button>
      <button onclick={() => del(l.name)}>Delete</button>
    </li>
  {/each}
</ul>
{#if sel}
  <div class="members">
    <div class="mh">Skills in "{sel.name}"<span class="sp"></span>
      <button onclick={() => (editing = !editing)}>{editing ? "Done" : "Edit"}</button></div>
    {#if editing}
      {#each state.skills as s (s.name)}
        {@const cap = "skill:" + s.name}
        <label class="opt"><input type="checkbox" checked={sel.skills.includes(cap)}
          onchange={() => toggleSkill(sel, cap)} /> {s.name}</label>
      {/each}
    {:else}
      {#each sel.skills as cap (cap)}<span class="chip">{cap.replace(/^skill:/, "")}</span>{/each}
      {#if !sel.skills.length}<em>none</em>{/if}
    {/if}
  </div>
{/if}
<style>
  .hd,.mh{display:flex;gap:6px;align-items:center;padding:6px 0} .sp{flex:1}
  .list{list-style:none;margin:0;padding:0}
  .list li{display:flex;gap:6px;align-items:center;padding:2px 0} .list li.sel{background:var(--vscode-list-activeSelectionBackground)}
  .pick{flex:1;text-align:left;background:transparent;color:var(--vscode-foreground)} .ct{opacity:.6;font-size:.85em;margin-left:6px}
  .members{border-top:1px solid var(--vscode-panel-border);margin-top:8px;padding-top:6px}
  .opt{display:block;padding:2px 0} .chip{display:inline-block;border:1px solid var(--vscode-panel-border);border-radius:3px;padding:0 6px;margin:2px}
</style>
```

- [ ] **Step 2: Mount in App.svelte**

Replace the loadouts placeholder with `<LoadoutTab {state} />`; add the import.

- [ ] **Step 3: svelte-check + build**

Run: `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json && npm run build`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add pi-vscode/hub-app/src
git commit -m "feat(hub-app): Loadouts tab with activate/CRUD/member edit"
```

**verify:** `cd pi-vscode/hub-app && npx svelte-check --tsconfig ./tsconfig.json`

---

### Task 14: End-to-end build, packaging, manual verification

**Files:**
- Modify: `pi-vscode/HANDOFF.md` (document the hub + removed sidebar)
- (No new source — integration task.)

**Interfaces:**
- Consumes: everything from Tasks 1–13.

- [ ] **Step 1: Full agent-side test suite**

Run: `cd agent/extensions/pi-bridge && npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 2: Full extension build**

Run: `cd pi-vscode && npx tsc -p tsconfig.json && npm --prefix hub-app install && npm --prefix hub-app run build && npx vitest run`
Expected: compiles, `hub-dist/index.html` regenerated, extension unit tests pass.

- [ ] **Step 3: Package the VSIX**

Run: `cd pi-vscode && npx @vscode/vsce package`
Expected: produces `pi-vscode-0.1.0.vsix` with no packaging errors. Confirm `hub-dist/` is included and `hub-app/` source is excluded (the `.vscodeignore` rules).

- [ ] **Step 4: Manual smoke test (documented checklist)**

Install the VSIX (`code --install-extension pi-vscode-0.1.0.vsix`), reload, start pi, run `pi: Connect`, then `pi: Open Agent Hub` (Ctrl+Shift+Alt+P). Verify: panel opens in editor area; tabs render and reorder (persists across reopen); Library tree + doc preview + Open in Editor; Skills dots reflect active loadout + SKILL.md preview; Tools filter + schema + toggle flips `✓` and persists in the active set; Loadouts list shows active, Activate switches it (footer updates), New/Duplicate/Delete/Edit round-trip to `loadouts.yaml`. Confirm theme matches on light + dark.

- [ ] **Step 5: Update HANDOFF.md**

Replace the sidebar description with the hub architecture: the four tabs, `PiHubStore`/`PiHubPanel`, the new bridge protocol messages, the `loadoutGateway`, and the `read_file` allow-list. Note Sessions/Files/Stats are dropped pending Phase 2.

- [ ] **Step 6: Commit**

```bash
git add pi-vscode/HANDOFF.md pi-vscode/pi-vscode-0.1.0.vsix
git commit -m "chore(pi-vscode): rebuild VSIX + document Pi Agent Hub (Phase 1)"
```

**verify:** `cd pi-vscode && npx tsc -p tsconfig.json && npm --prefix hub-app run build && npx @vscode/vsce package`

---

## Self-Review

**Spec coverage:** §5.1 removals → Task 4. §5.2 store/panel/bridge/types → Tasks 5–7. §5.3 gateway/protocol/handlers → Tasks 1–3. §6 HubState → Task 5/6. §7 protocol → Tasks 3, 5. §8 four tabs → Tasks 10–13. §9 CSP/allow-list/build → Tasks 2, 7, 8. §10 error handling → offline banner (Task 9 footer/App), preview errors (Tasks 10–11), gateway defaults (Task 1). §11 testing → Tasks 1, 2, 6, 14. All sections covered.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; verify commands are concrete.

**Type consistency:** `Loadout`/`HubState`/`ToolEntry`/`SkillEntry`/`KBDocCollection` identical across agent `loadoutGateway.ts`, extension `types.ts`, and hub-app `lib/types.ts`. Cap-id convention (`skill:<name>`, `tool:pi:<name>`) used consistently in gateway, Skills tab, Loadouts tab. Webview message names (`readFile`/`toggleTool`/`activateLoadout`/`createLoadout`/`updateLoadout`/`deleteLoadout`/`openInEditor`/`revealDir`/`persistUi`/`ready`) match between `PiHubPanel.onMessage` (Task 7) and `lib/bridge.ts` callers (Tasks 8–13).

**Known follow-ups (Phase 1.5/2, not gaps):** KB ingest/import/reindex, Skills scaffold/reload, Sessions/Files/Stats tabs — explicitly out of scope per spec §13.

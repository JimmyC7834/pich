# pi-vscode Redesign — Pi Agent Hub Panel (Phase 1)

> **Status:** Approved design (2026-06-20). Owner: jc4649. Supersedes the activity-bar
> sidebar with a single tabbed editor-area WebView panel. Phase 1 covers sidebar removal,
> the Svelte/Vite hub scaffold, four capability tabs (Library, Skills, Tools, Loadouts),
> and the pi-bridge protocol extensions that feed them. Sessions/Files/Stats are dropped
> from the old sidebar and **reimplemented as hub tabs in a Phase 2 spec**.

---

## 1. Goal

Replace the current pi-vscode activity-bar sidebar (Sessions, Files, Capabilities, Stats)
with a **single tabbed WebView panel in the editor area** — the "Pi Agent Hub" — built with
Svelte 5 + Vite and fed live data over the existing pi-bridge WebSocket. Phase 1 ships four
tabs: **Library** (knowledge base), **Skills**, **Tools**, **Loadouts**.

**Why:** The sidebar's narrow column constrains rich browse/preview/manage UX. One editor-area
panel with instant tab switching gives room for a tree + preview pane per surface, and a real
component framework (Svelte) replaces hand-written HTML-string webviews.

## 2. Context (for an agent with no prior context)

- Two components communicate over `ws://127.0.0.1:{port}` (port file: `~/.pi/agent/.pi-bridge-port`):
  - **pi-bridge** (`agent/extensions/pi-bridge/`) — WebSocket server running *inside* the pi
    agent. Pushes `state`/`session_tree`/`kb_collections`/`skills`/`capabilities` events;
    handles inbound command messages. Has full access to the `pi` ExtensionAPI.
  - **pi-vscode** (`pi-vscode/`) — the VS Code extension. `src/bridge.ts` is the WS client
    (EventEmitter); `src/store.ts` is the reactive state hub; `src/sidebar/*` are the views
    being removed.
- The **loadout system** lives in a *separate* pi extension, `pi-capability-index`:
  - `LoadoutService` (`src/loadouts.ts`) persists YAML at `~/.pi/capabilities/loadouts.yaml`
    with shape `{ core: string[], active: string, loadouts: Record<string, Loadout> }`.
  - `Loadout = { name, description, skills: string[], tools: string[], mcp: string[] }`.
  - Capability IDs are prefixed: **`skill:<name>`**, **`tool:pi:<name>`**, **`mcp:<...>`**.
  - `before_agent_start` re-reads `getActiveSkillIds()` from that YAML **every turn**, so
    changing `active:` propagates to the skill set on the next turn with no coupling.
  - Live **tool** re-sync (`pi.setActiveTools`) only runs on `session_start` and only when the
    agent's `CAP_DEFER_TOOLS` env is set — a documented Phase-1 limitation, not fixed here.
- pi extensions do **not** share an in-process registry, so pi-bridge reaches the loadout
  system by reading/writing the same `loadouts.yaml` directly (chosen approach, see §5).
- Relevant pi APIs confirmed present: `pi.getAllTools()`, `pi.getActiveTools()`,
  `pi.setActiveTools(names)`, `pi.getCommands()`, `pi.sendUserMessage()`.
- `kb_ingest` exists only as an **agent-invoked tool** in `pi-semble` (`{title, collection,
  body, sources}`) — there is no bridge-callable URL-fetch ingest, so KB write actions are
  deferred (see §8).

## 3. Approved decisions

| # | Decision | Choice |
|---|----------|--------|
| Loadout wiring | how pi-bridge drives loadouts | **A — direct YAML gateway** (read/write `loadouts.yaml`) |
| Sidebar | fate of the old activity-bar sidebar | **Remove entirely**; redesign as the hub |
| Sessions/Files/Stats | old sidebar views not in the hub design | **Drop now, reimplement as hub tabs in Phase 2** |
| UI stack | webview framework | **Svelte 5 + Vite**, single inlined HTML bundle |
| Phasing | this spec's scope | **Phase 1** = sidebar removal + hub scaffold + 4 capability tabs + bridge extensions |

## 4. Architecture & data flow

```
pi-capability-index ext ──(loadouts.yaml)──┐
pi agent (events, getAllTools, KB on disk) │
            │                              ▼
   pi-bridge ext (WS server) ◄── reads YAML, file contents, capabilities
            │  WS  ws://127.0.0.1:{port}
            ▼
   PiBridge (src/bridge.ts)  — EventEmitter (+ loadouts, fileContent events)
            ▼
   PiHubStore (src/hub/PiHubStore.ts) — aggregates + debounces into one HubState
            ▼
   PiHubPanel (src/hub/PiHubPanel.ts) — WebviewPanel, postMessage(HubState)
            ▼
   Svelte 5 app (hub-app/ → hub-dist/index.html, inlined w/ CSP nonce)
       TabBar · LibraryTab · SkillsTab · ToolsTab · LoadoutTab
```

Live data flows **bridge → store → panel → webview**. User actions flow **webview → panel →
bridge → pi** (loadout writes, tool toggles, file reads).

## 5. Components

### 5.1 Removals (sidebar teardown)

- `package.json` `contributes`: delete the `pi-sidebar` viewsContainer, all four `views`
  (`pi-sessions`, `pi-files`, `pi-capabilities`, `pi-stats`), and their `view/title` /
  `view/item/context` menu entries. Remove the now-dead `onView:*` activation events; add
  `onCommand:pi.openHub`.
- Delete `src/sidebar/` (`sessions.ts`, `files.ts`, `capabilities.ts`, `stats.ts`).
- Prune the corresponding registrations from `extension.ts`.
- **Keep** `bridge.ts`, `store.ts`, `terminal.ts`, `statusBar.ts`, `commands.ts`, `diff.ts`,
  `sessionManager.ts`, `correlate.ts`, `registry.ts` — they still serve the hub, status bar,
  and session lifecycle. (Sessions/Files/Stats UI is dropped; the underlying plumbing that
  Phase 2 will reuse stays.)

### 5.2 Extension-side new code

- **`src/types.ts`** — add `Loadout`, `HubState`, and payload types for the new
  `loadouts` / `file_content` events. `HubState` per §6.
- **`src/hub/PiHubStore.ts`** — subscribes to bridge `capabilities`, `loadouts`,
  `fileContent`, `connected`, `disconnected`; holds the canonical `HubState`; emits `changed`
  debounced ~50 ms; de-dupes pushes by JSON equality (as the current capabilities webview does).
- **`src/hub/PiHubPanel.ts`** — singleton wrapper around `vscode.window.createWebviewPanel(
  "piHub", "Pi Agent Hub", ViewColumn.Active, { enableScripts: true,
  retainContextWhenHidden: true, localResourceRoots: [hub-dist] })`. On show: load
  `hub-dist/index.html`, rewrite asset references to `webview.asWebviewUri`, inject a strict
  CSP `<meta>` + per-load nonce, post the initial `HubState`, subscribe to store `changed` to
  post updates. Reveals the existing panel if already open. Routes inbound webview messages to
  bridge requests / VS Code commands. Persists `tabOrder`, `activeTab`, and `collapsedGroups`
  via `context.workspaceState`.
- **`src/bridge.ts`** — add `loadouts` and `fileContent` to `PiBridgeEvents` + `handleMessage`;
  add typed request helpers (`listLoadouts`, `activateLoadout`, `createLoadout`,
  `updateLoadout`, `deleteLoadout`, `toggleTool`, `readFile`) over the existing `send` reply
  mechanism.
- **`src/extension.ts`** — construct `PiHubStore` + `PiHubPanel`; register commands
  `pi.openHub` (reveal/create panel) and `pi.hub.refresh` (re-request capabilities + loadouts).

### 5.3 Agent-side pi-bridge extensions

- **`agent/extensions/pi-bridge/loadoutGateway.ts`** (new) — reads/writes
  `~/.pi/capabilities/loadouts.yaml` mirroring `LoadoutService`'s `{core, active, loadouts}`
  shape using the existing `yaml` dependency. Functions: `list()`, `get(name)`,
  `create(name, init)`, `update(name, patch)`, `remove(name)`, `addCap(name, capId)`,
  `removeCap(name, capId)`, `setActive(name)`. Defensive defaults when the file is absent.
- **`agent/extensions/pi-bridge/protocol.ts`** — add inbound message types `loadout_list`,
  `loadout_create`, `loadout_delete`, `loadout_update`, `loadout_activate`, `tool_toggle`,
  `read_file`; add outbound events `loadouts` and `file_content`.
- **`agent/extensions/pi-bridge/index.ts`** — handle the new inbound messages:
  - loadout ops → gateway, then broadcast a fresh `loadouts` event.
  - `tool_toggle` → compute next active set from `pi.getActiveTools()`, call
    `pi.setActiveTools(next)`, then rebuild + broadcast `capabilities`.
  - `read_file` → **path allow-list** check (see §9), bounded read, reply `file_content`.
  - On `session_start`, also broadcast the initial `loadouts` event.

## 6. Data flow — HubState

```typescript
interface HubState {
  connected: boolean;
  collections: KBDocCollection[];          // from capabilities.kBCollections
  skills: SkillEntry[];                     // from capabilities.skills
  tools: ToolEntry[];                       // from capabilities.tools
  loadouts: Loadout[];                      // from loadouts event
  activeLoadout: string | null;            // from loadouts event
  docContents: Record<string, string>;     // path → markdown, lazily filled via read_file
}
// UI-only, persisted via workspaceState (not in HubState pushes):
//   tabOrder: string[]; activeTab: string; collapsedGroups: Record<string, boolean>;
```

Doc/skill previews are lazy: a click sends `read_file`; the reply fills `docContents[path]`.

## 7. Bridge protocol (final, Phase 1)

**Requests (IDE → pi-bridge):** `loadout_list`, `loadout_create {name, skills?, tools?}`,
`loadout_delete {name}`, `loadout_update {name, skills?, tools?, description?}`,
`loadout_activate {name}`, `tool_toggle {name, active}`, `read_file {path}`.

**Events (pi-bridge → IDE):** existing `state`, `session_tree`, `kb_collections`, `skills`,
`capabilities`, `file_changed`, `files_cleared`, `error`, `response`; **new**
`loadouts {loadouts: Loadout[], active: string}` and `file_content {path, content}`.

(KB deep-search and ingest are excluded from Phase 1 — see §8.)

## 8. The four tabs

- **Library** — collections tree from `capabilities.kBCollections`; client-side fuzzy search
  over title + tags; click a doc → `read_file` → markdown preview pane; **Open in Editor**
  (`vscode.workspace.openTextDocument`), **Copy Doc ID**. *Deferred to Phase 1.5:* Ingest URL,
  Import File, Reindex (no bridge-callable ingest API). Deferred buttons are omitted in Phase 1.
- **Skills** — list from `capabilities.skills`; filled dot `●` = in active loadout, hollow `○`
  = on-demand; click → SKILL.md preview via `read_file`; **Open Dir**
  (`revealInExplorer`). *Deferred to Phase 1.5:* New Skill (scaffold), Reload.
- **Tools** — list from `capabilities.tools`; `✓` = active; source badge (`builtin`,
  `ext:<name>`, `sdk`); filter All / Active Only; client-side name filter; click → detail pane
  (description + JSON schema); **Toggle** → `tool_toggle` request.
- **Loadouts** — list from the `loadouts` event; active loadout marked; selecting one shows its
  member skills/tools (membership derived by matching cap-id suffix to skill/tool names —
  `skill:<name>`, `tool:pi:<name>`); **Activate** (`loadout_activate`), **New** / **Duplicate**
  / **Edit** (toggle members) / **Delete** via the loadout requests.

## 9. Security & packaging

- **WebView CSP:** `default-src 'none'; img-src {webview.cspSource} data:;
  style-src {webview.cspSource} 'unsafe-inline'; script-src 'nonce-{nonce}';` with a fresh
  nonce per load. No external network access.
- **`read_file` path allow-list:** before reading, resolve the real absolute path (resolve
  symlinks, reject `..` traversal) and require it to live under one of: `~/.pi/skills/`,
  `~/.pi/kb/`, `~/.pi/capabilities/`. Anything else → `error` reply, never contents. This stops
  arbitrary-file exfiltration over the localhost socket.
- **Build:** `hub-app/` is Svelte 5 + Vite + TS, building a single inlined HTML to
  `pi-vscode/hub-dist/index.html` (`rollupOptions.output.inlineDynamicImports`, no code split,
  `manualChunks: undefined`). `pi-vscode/package.json` `compile` and `vscode:prepublish` chain
  `cd hub-app && npm install && npm run build` after `tsc`. `.vscodeignore` excludes
  `hub-app/` source, includes `hub-dist/`. Package via `@vscode/vsce`.

## 10. Error handling

- Disconnected bridge → hub renders an "offline" banner; cached `HubState` stays browsable
  (search/preview of already-loaded content works offline; writes are disabled).
- `read_file` denial / failure → preview pane shows an inline error, not a crash.
- Loadout write failures (`error` reply) → toast/banner in the Loadouts tab; state re-fetched.
- Malformed/empty `loadouts.yaml` → gateway returns `{core:[], active:"base", loadouts:{}}`.

## 11. Testing

- **Agent:** vitest unit tests for `loadoutGateway` — YAML round-trip CRUD, `setActive`,
  `addCap`/`removeCap`, absent-file defaults (mirror `pi-semble`'s vitest style; `:memory:`/tmp
  file).
- **Extension:** unit test for `PiHubStore` aggregation + JSON de-dupe; unit test for the
  `read_file` path allow-list (accept in-root, reject traversal/out-of-root).
- **Manual:** build hub, `pi.openHub`, verify each tab against a live pi session
  (browse/preview/toggle/loadout-activate), confirm theme tokens, reconnect behavior, and tab
  reorder persistence.

## 12. Known risks

- Cap-id ↔ name mapping fidelity — verify the exact `skill:` id format at implementation time
  before relying on suffix matching.
- Tool-toggle persistence vs. `pi-capability-index` recompute (toggle may be re-derived on next
  session/turn under `CAP_DEFER_TOOLS`).
- New Svelte/Vite toolchain added to the extension build.
- Webview asset-URI rewriting for an inlined single-file bundle.

## 13. Out of scope (Phase 1)

KB ingest/import/reindex and KB deep semantic search; Skills scaffold/reload; Sessions, Files,
and Stats hub tabs (Phase 2); any change to `pi-capability-index` internals.

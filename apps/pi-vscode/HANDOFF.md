# pi VS Code Extension — Project Handoff

> **For the next agent:** This is a two-component project that gives pi (the terminal-based coding agent) a VS Code **Agent Hub** — a webview panel with four tabs replacing the old sidebar. Read this before touching anything.

---

## What This Is

A VS Code extension + pi companion extension that connect over a local WebSocket (127.0.0.1, random port). The VS Code side provides a **Pi Agent Hub** webview panel (Library → KBDoc tree, Skills → loadout-membership dots, Tools → active toggle + schema, Loadouts → CRUD/activate) plus a status bar and commands. The pi side (pi-bridge with a new `loadoutGateway`) exposes pi's internal state via WebSocket.

The old sidebar panels (Sessions, Files, KB, Skills, Stats) are **dropped** pending Phase 2 — replaced by the webview-based hub.

---

## Architecture (Two Components)

```
VS Code Extension (pi-vscode/)          pi Extension (agent/extensions/pi-bridge/)
────────────────────────────────────    ──────────────────────────────────────────
src/extension.ts (main entry)           index.ts (main entry + ws push)
src/bridge.ts (WebSocket client)        server.ts (WebSocket server, port discovery)
src/hub/PiHubStore.ts (reactive state)  protocol.ts (WS message types)
src/hub/PiHubPanel.ts (webview panel)   commands.ts (proxy /pi-bridge-fork etc.)
src/terminal.ts (launches pi terminal)  loadoutGateway.ts (skills/tools/loadouts/KB queries)
src/statusBar.ts                        safeRead.ts (file read with allow-list)
src/commands.ts (Ctrl+Shift+P)
hub-app/ (Svelte 5 webview UI)          package.json (ws dependency)
  ├── src/App.svelte (shell + tabs)
  ├── src/TabBar.svelte
  └── src/tabs/
      ├── LibraryTab.svelte   (KB tree + doc preview)
      ├── SkillsTab.svelte    (filterable list + loadout dots + SKILL.md preview)
      ├── ToolsTab.svelte     (filter/schema/active-toggle)
      └── LoadoutTab.svelte   (CRUD + activate + skill*member edit)
```

**Communication:** VS Code hub webview ↔ postMessage ↔ PiHubPanel ↔ PiHubStore ↔ WebSocket ↔ pi-bridge.

**Port discovery (unchanged):** pi-bridge writes `~/.pi/agent/.pi-bridge-port` → VS Code reads it → connects.

---

## Directory Layout

```
~/.pi/
├── agent/extensions/pi-bridge/        ← pi extension (the server)
│   ├── index.ts                       ← entry: event subscriptions + WS push + loadoutGateway*
│   ├── server.ts                      ← BridgeServer class (bind, broadcast)
│   ├── protocol.ts                    ← PiToVSCode / VSCodeToPi types
│   ├── commands.ts                    ← /pi-bridge-fork, /pi-bridge-resume
│   ├── loadoutGateway.ts              ← *NEW* queries for skills, tools, loadouts, KB
│   ├── safeRead.ts                    ← *NEW* read_file with allow-list
│   ├── package.json
│   └── node_modules/ws/
│
└── pi-vscode/                         ← VS Code extension (the client)
    ├── package.json                   ← Extension manifest + commands + views
    ├── tsconfig.json
    ├── .vscodeignore                  ← Excludes src, includes hub-dist/ + node_modules/ws
    ├── pi-vscode-0.1.0.vsix           ← Built package
    ├── node_modules/ws/
    ├── hub-app/                       ← *NEW* Svelte 5 webview source (excluded from vsix)
    ├── hub-dist/                      ← *NEW* built hub-app (included in vsix)
    └── src/
        ├── extension.ts               ← activate(): wires bridge↔store, registers hub
        ├── types.ts                   ← HubState, Loadout, KBDocCollection, etc.
        ├── bridge.ts                  ← PiBridge class (connect, send, emit events)
        ├── hub/
        │   ├── PiHubStore.ts          ← *NEW* reactive state store (extends EventEmitter)
        │   └── PiHubPanel.ts          ← *NEW* webview panel + message routing
        ├── terminal.ts                ← PiTerminal (creates VS Code terminal)
        ├── statusBar.ts               ← PiStatusBar (bottom bar: model | tokens | cost)
        └── commands.ts                ← pi:Start, pi:Stop, pi:OpenHub, etc.
```

---

## Hub Protocol (WebView ↔ Extension ↔ pi-bridge)

### state → webview (via PiHubPanel.postState)
```typescript
{
  connected: boolean;
  collections: KBDocCollection[];  // { name, docs: {id,title,filePath,tags}[] }
  skills: SkillEntry[];            // { name, description, filePath, tags, category, isActive }
  tools: ToolEntry[];              // { name, description, schema, source, sourcePath, isActive }
  loadouts: Loadout[];             // { name, description, skills[], tools[], mcp[] }
  activeLoadout: string | null;
  docContents: Record<string, string>;  // cached file reads
}
```

### webview → extension (postMessage)
| Message | Action |
|---------|--------|
| `{ type:"readFile", path }` | Read file via safeRead, cache in docContents |
| `{ type:"openInEditor", path }` | Reveal file in VS Code editor |
| `{ type:"revealDir", path }` | Open file's directory in Explorer |
| `{ type:"toggleTool", name, active }` | Activate/deactivate a tool |
| `{ type:"activateLoadout", name }` | Switch active loadout |
| `{ type:"createLoadout", loadout }` | Add new loadout |
| `{ type:"updateLoadout", loadout }` | Save edited loadout |
| `{ type:"deleteLoadout", name }` | Remove loadout |
| `{ type:"persistUi", tabOrder, activeTab }` | Save tab layout to VS Code globalState |

### pi-bridge → VS Code (push events, same as before)
```typescript
{ type: "state",                data: HubState }
{ type: "session_tree",         data: { sessions: SessionInfo[], active: string } }
{ type: "tool_start",           data: { toolName, toolCallId, path } }
{ type: "error",                data: { message } }
```

---

## Hub Webview Build (hub-app)

- Framework: Svelte 5 (SvelteKit-style web app, built as static HTML+JS)
- Build: `cd pi-vscode/hub-app && npm run build` → outputs to `hub-dist/`
- UI components: TabBar (drag-reorder), SearchBar, Badge, ChevronGroup, Dot
- No run-time dependencies (self-contained SPA served from extension HTML)

### CSP / Security
- Webview uses `vscode.WebviewOptions` with strict CSP
- File read uses `safeRead.ts` allow-list (only `*.md`, `*.yaml`, `*.yml` in specific paths)
- No eval, no inline scripts

---

## VS Code — How to use

1. Install: `code --install-extension pi-vscode-0.1.0.vsix`
2. Reload VS Code
3. Status bar appears: "pi: not connected"
4. Run `Ctrl+Shift+P` → **"pi: Start (launch + connect)"**
5. Or if pi is already running: **"pi: Connect (to running pi)"**
6. Run `Ctrl+Shift+Alt+P` → **"pi: Open Agent Hub"** → webview panel with 4 tabs
7. Hub panel has 4 tabs: Library (KB docs), Skills (loadout membership), Tools (toggle), Loadouts (CRUD)

### Commands (Ctrl+Shift+P)
| Command | What it does |
|---------|-------------|
| `pi: Start` | Launch pi terminal + connect bridge |
| `pi: Connect` | Connect to already-running pi |
| `pi: Stop` | Shutdown WS + Ctrl+C terminal |
| `pi: Open Agent Hub` | Open the Pi Agent Hub webview panel |
| `pi: New Session` | Send `/new` to pi terminal |

---

## Current Status / Known Issues

### ✅ Working
- pi-bridge loads, starts WS server, writes port file
- VS Code connects via WebSocket
- Pi Agent Hub opens in editor webview panel
- Library tab: KB tree with client-side filter, doc preview, Open in Editor, Copy Doc ID
- Skills tab: filterable list with loadout-membership dots, SKILL.md preview, Open Dir
- Tools tab: filterable list, source badges, Active-only toggle, JSON schema detail, toggle on/off
- Loadouts tab: CRUD (create/duplicate/rename/delete), activate, edit skill*member membership
- Tab drag-reorder persists across hub reopen
- Status bar shows connected/disconnected + active loadout
- `pi: Start` launches terminal

### ⚠️ Needs Verification
- File read allow-list coverage for all doc paths used by KB
- Tool toggle actually persists via pi's loadout mechanism (requires running extension test with real pi integration)
- Loadout CRUD round-trips to `loadouts.yaml`

### 🔮 Future Improvements (Phase 1.5 / Phase 2)
- KB ingest/import/reindex tab
- Skills scaffold/reload
- Sessions, Files, Stats tabs (dropped from sidebar, pending re-add as hub tabs)
- Dark/light theme toggle within hub
- Reconnect on pi restart without manual `pi: Connect`

---

## Build & Deploy

```bash
# pi-bridge (auto-loaded by pi on startup, no build needed)
cd ~/.pi/agent/extensions/pi-bridge
npm install

# Hub webview app (build first, then extension)
cd ~/.pi/pi-vscode/hub-app
npm install
npm run build

# VS Code extension (build + pack + install)
cd ~/.pi/pi-vscode
npx tsc -p tsconfig.json
npx @vscode/vsce package
code --install-extension pi-vscode-0.1.0.vsix
```

After deploy: reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window"), then restart pi so pi-bridge reloads.

---

## Key Design Decisions

1. **WebSocket, not RPC or file polling** — Same reasoning as before. WS gives real-time events with single pi instance.

2. **pi-bridge runs inside pi, not as separate process** — Full access to extension APIs. Tradeoff: bridge dies with pi.

3. **WebView over sidebar panels** — More flexible UI than TreeDataProvider. Svelte 5 gives faster iteration for complex interactive UIs (tabs, filters, toggles, CRUD). No need for extension reload on UI changes after hub-app build.

4. **loadoutGateway queries on push** — The pi-bridge collates skills/tools/loadouts/KB data into a single `HubState` object at `session_start` and on `skills_reloaded`/`loadout_changed` events, rather than lazily.

5. **safeRead with allow-list** — Only `.md` and `.yaml`/`.yml` files in specific pi paths can be read through the hub. Prevents arbitrary file access through the webview.

6. **Cached docContents** — Once a file is read via `readFile`, its content is cached in `HubState.docContents` to avoid re-reading on every tab switch.

7. **No `$state` runes** — Svelte 5's `$state()` rune triggers a TypeScript shim error with `svelte-check` on this project. Components use `let` + `$derived` instead. Warnings only, no errors. Fixable by updating the TypeScript `svelte` shim to export `$state`.

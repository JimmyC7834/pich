# Pi Agent Hub — VS Code Panel Design

## Overview

A **tabbed editor-area panel** for the pi-vscode extension that provides a rich UI for managing the pi coding agent's knowledge library, skills, tools, and loadouts. Built with Svelte + Vite and fed live data via the existing pi-bridge WebSocket.

## Architecture

```
pi-bridge (WebSocket server in pi agent)
    │
    │  state | capabilities | skills | kb_collections | loadouts
    ▼
PiBridge (pi-vscode/src/bridge.ts) — EventEmitter
    │
    ▼
PiHubStore (new) — aggregates bridge events, debounces
    │
    ▼
PiHubPanel (WebViewPanel) — postMessage(serialized state)
    │
    ▼
Svelte App (in WebView)
    ├─ TabBar (draggable reorder)
    ├─ LibraryTab
    ├─ SkillsTab
    ├─ ToolsTab
    └─ LoadoutTab
```

## File Structure (new)

```
pi-vscode/
├── src/
│   ├── extension.ts           # + register PiHubPanel
│   ├── bridge.ts              # + loadout/ingest/commands events
│   ├── types.ts               # + Loadout, LoadoutEntry
│   ├── hub/
│   │   ├── PiHubPanel.ts      # createWebviewPanel wrapper
│   │   ├── PiHubStore.ts      # Aggregates bridge state for hub
│   │   └── tabOrder.ts        # Persisted tab order
│   └── ...
├── hub-app/                   # Svelte + Vite app (NEW)
│   ├── package.json
│   ├── vite.config.ts
│   ├── svelte.config.js
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.ts
│       ├── App.svelte
│       ├── TabBar.svelte
│       ├── tabs/
│       │   ├── LibraryTab.svelte
│       │   ├── SkillsTab.svelte
│       │   ├── ToolsTab.svelte
│       │   ├── LoadoutTab.svelte
│       │   └── DocPreview.svelte
│       ├── lib/
│       │   ├── search.ts      # Client-side fuzzy filter
│       │   ├── bridge.ts      # postMessage / onMessage typed wrapper
│       │   ├── types.ts       # Shared types mirroring src/types.ts
│       │   └── theme.ts       # VS Code CSS var bindings
│       └── components/
│           ├── SearchBar.svelte
│           ├── Badge.svelte
│           ├── Dot.svelte
│           ├── ChevronGroup.svelte
│           └── ActionBar.svelte
```

## Build Pipeline

The Svelte app is built as a **standalone static site** during the extension's `vscode:prepublish` step:

```bash
cd hub-app && npm run build
# Outputs to pi-vscode/hub-dist/index.html
```

At runtime, `PiHubPanel.ts` reads `hub-dist/index.html` from disk, inlines it as the WebView HTML, and injects a `<script>` with the initial state.

**package.json additions:**

```json
{
  "scripts": {
    "compile": "... && cd hub-app && npm run build",
    "vscode:prepublish": "... && cd hub-app && npm run build"
  }
}
```

## Tab Design

### Tab Bar

- **Rendered as a custom flexbox row** inside the WebView (VS Code's native tab bar is not available in WebViews)
- **Drag-to-reorder:** `mousedown` on tab header starts drag; `mousemove` follows cursor; `mouseup` commits swap. Uses `pointer-events` + `transform` for smooth follow
- **Order persisted** in `context.workspaceState` via `acquireVsCodeApi().setState`
- **Active tab** highlighted with VS Code's `--vscode-tab-activeBackground`
- **Tab icons:** 📚 Library, ⚡ Skills, 🛠 Tools, 📦 Loadouts

```
┌──────────┬──────────┬──────────┬───────────┬──────────────┐
│  📚 Lib  │  ⚡ Skil │  🛠 Tool │  📦 Load  │  [+ Add…]   │
│   rary   │   ls     │   s      │   out     │              │
└──────────┴──────────┴──────────┴───────────┴──────────────┘
```

Default order: Library → Skills → Tools → Loadout. User can reorder.

### Tab 1: 📚 Library

**Purpose:** Browse, search, preview, and manage the knowledge library (kb_* resources).

**Layout:**
```
┌────────────────────────────────────────────────────────────┐
│ [🔍 Search KB docs…                          ]    (count) │
├────────────────────────────────────────────────────────────┤
│ COLLECTIONS (collapsible tree)                             │
│ ├─ 📁 my-project/                        ▸ 3 docs         │
│ │  ├─ 📄 api-reference     ref   2d ago  [🔗][🗑]        │
│ │  ├─ 📄 migration-notes   note  5d ago  [🔗][🗑]        │
│ │  └─ 📄 deployment-guide  cur   1w ago  [🔗][🗑]        │
│ ├─ 📁 global/                           ▸ 12 docs         │
│ │  └─ ...                                                    │
├────────────────────────────────────────────────────────────┤
│ PREVIEW PANEL (shown when a doc is clicked)                │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ # API Reference                                        │ │
│ │ ## Endpoints                                           │ │
│ │ GET /users — returns user list...                      │ │
│ │                                                        │ │
│ │ [📂 Open in Editor] [🔗 Copy Doc ID]                    │ │
│ │ authority: reference  |  tags: api,rest                │ │
│ └────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────┤
│ [📎 Ingest URL] [📄 Import File] [🔄 Reindex]              │
└────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Tree loads from bridge `kb_collections` event (already exists)
- Inline fuzzy search across titles + tags (client-side, < 1ms for KB-sized datasets)
- Click doc → fetch full content via bridge → show in preview panel
- Authority badges: `ref` (reference), `cur` (curated), `note` (agent-note)
- "Open in Editor" → `vscode.workspace.openTextDocument` for the .md file
- "Ingest URL" → prompts URL input → sends `kb_ingest` command to bridge
- "Import File" → VS Code file dialog → reads file → sends to bridge
- No pagination needed — KBs are typically < 500 docs

### Tab 2: ⚡ Skills

**Purpose:** Browse, preview, and manage pi skills.

**Layout:**
```
┌────────────────────────────────────────────────────────────┐
│ [🔍 Search skills…                             ]    (N/N) │
├────────────────────────────────────────────────────────────┤
│ SKILL LIST                                               │
│ ● brainstorming          Creative/design pre-work         │
│ ● csv-export             Export data to CSV               │
│ ○ dispatching-parallel   Run independent tasks in...      │
│ ● finishing-dev-branch   Complete dev work...             │
│ ● grill-with-docs        Stress-test plans...             │
│ ○ handoff                Compact session...               │
│ ● = in active loadout   ○ = on-demand only               │
│ (N total, M in loadout                                   │
├────────────────────────────────────────────────────────────┤
│ PREVIEW PANEL (when a skill is clicked)                   │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ brainstorming                                          │ │
│ │ ────────────────────────────────────────────────────── │ │
│ │ name: brainstorming                                    │ │
│ │ description: Use before creative work — explores...    │ │
│ │ path: ~/.pi/skills/brainstorming/SKILL.md              │ │
│ │ license: (none)                                        │ │
│ │                                                        │ │
│ │ ┌─ SKILL.md preview (first 50 lines) ────────────────┐ │ │
│ │ │ You MUST use this before any creative work...       │ │
│ │ │ ...                                                 │ │
│ │ └────────────────────────────────────────────────────┘ │ │
│ │                                                        │ │
│ │ [📂 Open Dir] [➕ New Skill] [🔄 Reload]               │ │
│ └────────────────────────────────────────────────────────┘ │
```

**Behavior:**
- Loads from bridge `capabilities.skills` + `skills` event (already exists)
- Dot: filled `●` = in active loadout, hollow `○` = available on-demand
- Click → show SKILL.md preview in bottom panel (fetched via bridge `read_file` command)
- "Open Dir" → `vscode.commands.executeCommand('revealInExplorer', skillDir)`
- "New Skill" → scaffolds a SKILL.md with frontmatter
- "Reload" → pings bridge to re-scan skill directories

### Tab 3: 🛠 Tools

**Purpose:** Browse and toggle pi's registered tools.

**Layout:**
```
┌────────────────────────────────────────────────────────────┐
│ Filter: [____________]  ● All  ○ Active Only              │
├────────────────────────────────────────────────────────────┤
│ ✓ read       Read file contents               builtin     │
│ ✓ bash       Execute shell commands           builtin     │
│ ✓ edit       Edit files with anchored lines   builtin     │
│ ✓ write      Write/overwrite files            builtin     │
│ ○ web_search Web search via Brave API         ext:web     │
│ ○ code_search Programming API lookups         ext:web     │
│ ✓ subagent   Delegate to subagents            ext:pi-s    │
│ ○ remember   Save a durable fact              builtin     │
│ ...                                                    │
├────────────────────────────────────────────────────────────┤
│ DETAILS PANEL (when a tool is clicked)                    │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ read                                                   │ │
│ │ ────────────────────────────────────────────────────── │ │
│ │ Description: Read file contents with anchored lines    │ │
│ │ Source: builtin (builtin)                               │ │
│ │ Schema: {                                               │ │
│ │   path: string,                                         │ │
│ │   offset?: number,                                      │ │
│ │   limit?: number                                        │ │
│ │ }                                                       │ │
│ │                                                         │ │
│ │ Status: ● Active  [Toggle Off]                          │ │
│ └────────────────────────────────────────────────────────┘ │
```

**Behavior:**
- Loads from bridge `capabilities.tools` (already exists)
- Checkbox `✓` = tool is active
- Source badge: `builtin`, `ext:<name>`, `sdk`
- Filter: "All" / "Active Only"
- Click → detail panel with full description + JSON schema
- Toggle → sends `tool_toggle` command to bridge → bridge calls `pi.setActiveTools`

### Tab 4: 📦 Loadouts

**Purpose:** Manage named loadout sets.

**Layout:**
```
┌─ Active: default ──────────────────────────────────────────┐
│ ┌─ LOADOUT LIST ──────────────────────────────────────────┐ │
│ │ ● default             6 skills    (active)  [Activate]  │ │
│ │ ○ development        10 skills              [Activate]  │ │
│ │ ○ research-only       2 skills              [Activate]  │ │
│ │ ○ minimal             0 skills              [Activate]  │ │
│ │                                                        │ │
│ │ [➕ New Loadout]                                        │ │
│ ├─ Skills in "default" ──────────────────────────────────┤ │
│ │ ✓ brainstorming      ✓ csv-export                      │ │
│ │ ✓ dispatching-par…   ✓ finishing-dev-branch            │ │
│ │ ✓ grill-with-docs    ✓ test-driven-development         │ │
│ │                                                        │ │
│ │ [Edit] [Duplicate] [Delete] [Promote to Session]       │ │
│ └────────────────────────────────────────────────────────┘ │
```

**Behavior:**
- Loads from bridge via `loadout_list` command (NEW)
- Active loadout marked with `(active)`
- Selecting a loadout → shows which skills it includes (with checkboxes)
- "Activate" → `loadout_activate` command to bridge
- "New" → dialog to name + pick skills
- "Edit" → toggle individual skills in this loadout
- "Duplicate" → clone the loadout with a new name
- "Delete" → confirm + remove
- "Promote to Session" → temporarily override via `loadout_activate` with session scope

## Bridge Protocol Extensions

The existing pi-bridge agent extension needs these new message types:

### Requests (IDE → pi-bridge)

```typescript
// List loadouts
{ id: "req-1", type: "loadout_list" }

// Create loadout
{ id: "req-2", type: "loadout_create", data: { name: "my-set", skills: ["brainstorming", "tdd"] } }

// Delete loadout
{ id: "req-3", type: "loadout_delete", data: { name: "my-set" } }

// Update skills in loadout
{ id: "req-4", type: "loadout_update", data: { name: "my-set", skills: ["brainstorming", "tdd", "debugging"] } }

// Activate loadout
{ id: "req-5", type: "loadout_activate", data: { name: "default", scope?: "session" } }

// Toggle tool
{ id: "req-6", type: "tool_toggle", data: { name: "web_search", active: false } }

// Read a file (SKILL.md, KB doc)
{ id: "req-7", type: "read_file", data: { path: "..." } }

// Ingest a URL into KB
{ id: "req-8", type: "kb_ingest", data: { url: "https://..." } }

// Search KB (for deeper semantic search than client-side)
{ id: "req-9", type: "kb_search", data: { query: "..." } }
```

### Events (pi-bridge → IDE)

```typescript
// Already exists:
{ type: "state", data: Partial<PiState> }
{ type: "capabilities", data: CapabilitiesSnapshot }
{ type: "skills", data: SkillItem[] }
{ type: "kb_collections", data: { collections: KBCollection[] } }

// NEW:
{ type: "loadouts", data: { loadouts: Loadout[], active: string } }
{ type: "file_content", data: { path: string, content: string } }
{ type: "kb_search_results", data: { query: string, results: KBSearchResult[] } }
```

## VS Code Integration

### Registration (extension.ts)

```typescript
export function activate(context: vscode.ExtensionContext) {
  // ... existing code ...

  // ── Pi Hub panel ──
  const hubPanel = new PiHubPanel(context, bridge);
  context.subscriptions.push(
    vscode.commands.registerCommand("pi.openHub", () => hubPanel.show())
  );
}
```

### Commands

| Command | Title | Binding |
|---|---|---|
| `pi.openHub` | pi: Open Agent Hub | keyboard: `Ctrl+Shift+P pi: Hub` |
| `pi.hub.refresh` | pi: Refresh Hub | button in title bar |

### package.json additions

```json
{
  "contributes": {
    "commands": [
      {
        "command": "pi.openHub",
        "title": "pi: Open Agent Hub",
        "icon": "$(hubot)"
      }
    ],
    "keybindings": [
      {
        "command": "pi.openHub",
        "key": "ctrl+shift+alt+p",
        "when": "!editorFocus || editorTextFocus"
      }
    ]
  }
}
```

## Svelte App Details

### State Structure (passed via postMessage)

```typescript
interface HubState {
  // Connection
  connected: boolean;

  // Library
  collections: KBCollection[];
  docContents: Record<string, string>;  // docId → markdown

  // Skills
  skills: SkillEntry[];

  // Tools
  tools: ToolEntry[];

  // Loadouts
  loadouts: Loadout[];
  activeLoadout: string | null;

  // UI state (persisted via setState)
  tabOrder: string[];
  activeTab: string;
  collapsedGroups: Record<string, boolean>;
}
```

### Key Components

**`App.svelte`** — Root layout
```
<header> — title bar + tab bar
<main>  — active tab content
<footer> — status bar (connected/disconnected, active loadout)
```

**`TabBar.svelte`** — Draggable tab row
- `on:mousedown` → capture pointer → track delta → swap on release
- `transition:slide` for smooth reorder animation
- Calls `onReorder(newOrder)` callback → persisted via `acquireVsCodeApi().setState`

**`ChevronGroup.svelte`** — Collapsible section
- Used in Library (collections), Tools (source groups), Skills (loadout vs on-demand)
- Toggle + animate chevron rotation
- Default collapsed state persisted per group id

**`SearchBar.svelte`** — Debounced input
- 150ms debounce
- Emits `onSearch(text)` — local filter

## Build Configuration

### hub-app/vite.config.ts

```typescript
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "../hub-dist",
    emptyOutDir: true,
    // Single HTML file — no code splitting needed
    rollupOptions: {
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
});
```

### hub-app/package.json

```json
{
  "name": "pi-hub-app",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "svelte": "^5.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

No runtime dependencies — Svelte compiles away. Zero bundle weight beyond framework runtime (~3KB).

## Implementation Order

1. **Types + Store** — Add `Loadout`/`LoadoutEntry` types, create `PiHubStore`, extend bridge events
2. **PiHubPanel** — Wire up createWebviewPanel, load HTML, postMessage bridge data
3. **Svelte scaffold** — `npm create vite`, add 4 tab stubs, TabBar with drag
4. **Library tab** — Reuse/migrate existing Capabilities KB tree → tree + preview
5. **Skills tab** — Skill list + SKILL.md preview pane
6. **Tools tab** — Tool list + detail panel + toggle
7. **Loadout tab** — List, create, edit, delete, activate
8. **Bridge commands** — Extend pi-bridge for loadout CRUD and file reads
9. **Polish** — Drag-to-reorder, theme vars, responsive widths, transitions, error states

## Design Principles

- **One panel, many tabs** — Not multiple panels. One WebView, tab switching is instant
- **Client-side search** — No round-trip for filtering. Only KB deep search hits the bridge
- **Progressive disclosure** — Click a skill → show preview. Don't load all SKILL.md contents upfront
- **Live data, not polling** — Bridge pushes state deltas; the hub updates reactively
- **Zero extra runtime deps** — Svelte compiles away, no React/Vue/Angular runtime
- **Works offline** — Once data is loaded, search and browsing work without bridge connection

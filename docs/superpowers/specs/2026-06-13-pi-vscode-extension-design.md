# pi VS Code Extension — Design Spec

## Overview

A VS Code extension that provides an IDE-aware companion to pi's native TUI. Pi runs in the VS Code integrated terminal. A tabbed sidebar provides session tree navigation, file change tracking with diffs, knowledge library browsing, skills/commands inspection, and live activity stats. The VS Code extension communicates with pi through a companion pi extension (`pi-bridge`) that exposes pi's internal state via a local WebSocket server.

## Architecture

```
┌───────────────────────── VS Code ─────────────────────────────┐
│  ┌─ Sidebar (tabbed) ───────────────────────────────────────┐ │
│  │  [🌳 Sessions] [📝 Files] [📚 KB] [🧠 Skills] [📊 Stats] │ │
│  │  ┌──────────────────────────────────────────────────────┐ │ │
│  │  │  Active tab content (TreeDataProvider)               │ │ │
│  │  └──────────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌─ Editor Area ──┐  ┌─ Terminal ──────────────────────────┐ │
│  │  src/app.ts     │  │  pi (TUI)                           │ │
│  │                 │  │  > _                                │ │
│  └─────────────────┘  └─────────────────────────────────────┘ │
│                                                                │
│  ┌─ Extension Host ──────────────────────────────────────────┐ │
│  │  piSidebar.ts  ◄── ws://127.0.0.1:RANDOM ──►  pi-bridge  │ │
│  │  (TreeDataProvider,       WebSocket JSON       (pi ext)   │ │
│  │   VS Code APIs)                             in pi TUI     │ │
│  └───────────────────────────────────────────────────────────┘ │
│  ┌─ Status Bar ──────────────────────────────────────────────┐ │
│  │  🟢 pi: claude-sonnet-4 | ↑2.4k ↓1.8k $0.12 | feat-auth  │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

### Two Components

| Component | Location | Responsibility |
|-----------|----------|---------------|
| **pi-bridge** extension | `~/.pi/agent/extensions/pi-bridge/` | Exposes pi state via WebSocket server on random localhost port. Listens to pi events and pushes structured data. Accepts commands from VS Code and executes them in pi context. |
| **VS Code extension** | Standard VS Code extension (`~/.vscode/extensions/pi-vscode-*`) | Sidebar views (TreeDataProvider registrations), status bar item, launches pi in terminal, command palette entries. Connects to pi-bridge WebSocket. |

### Communication: WebSocket JSON Protocol

```
VS Code Extension ◄──────────────────────────► pi-bridge
                    ws://127.0.0.1:RANDOM
```

**pi-bridge → VS Code (push events):**
```json
{"type":"state","data":{"model":"claude-sonnet-4","thinkingLevel":"medium","isStreaming":false}}
{"type":"session_tree","data":{"sessions":[...],"active":"feat-auth"}}
{"type":"kb_collections","data":{"collections":[...]}}
{"type":"file_changed","data":{"path":"/abs/path/file.ts","status":"M","toolCallId":"abc123"}}
{"type":"tool_start","data":{"toolName":"edit","toolCallId":"abc123","path":"/abs/path/file.ts"}}
{"type":"skills","data":[{name, description, filePath}]}
```

**VS Code → pi-bridge (commands):**
```json
{"type":"fork","entryId":"abc123"}
{"type":"resume","sessionFile":"/path/session.jsonl"}
{"type":"kb_open","docId":"collection/doc#0"}
{"type":"diff","path":"/abs/path/file.ts"}
{"type":"command","command":"/skill:brainstorming"}
```

### Security

- WebSocket server binds to `127.0.0.1` only (no external access)
- Random port per session
- No authentication (local-only IPC)
- Port file (`~/.pi/agent/.pi-bridge-port`) cleaned up on session shutdown

---

## Sidebar Tabs

### 🌳 Sessions Tab

Displays the session tree from pi's `sessionManager`.

```
 Active: feat-auth
   └─ fork: fix-login
   └─ fork: add-tests
 refactor-api
 main
```

**Click a leaf node:** Shows action buttons inline:
- **Fork here** — sends `fork` command to pi-bridge, opens editor with prompt
- **Resume** — sends `resume` command, switches active session
- **Copy ID** — copies entry ID to clipboard

**Data source:** `session_tree` WS push on connect, incremental updates on session change events.

### 📝 Files Tab

Tracks files modified by pi across tool calls.

```
 This Session (3)
   M  src/auth/login.ts        ← click → git diff in editor
   M  src/api/routes.ts
   A  src/api/middleware.ts

 All Sessions (12)
   M  src/utils/helper.ts
   ...
```

**File change detection:** pi-bridge hooks into `tool_call` and `tool_result` events for `edit` and `write` tools. When a tool finishes, it pushes `file_changed` to VS Code.

**Diff display:** On file click, the extension runs `git diff <path>` in the workspace. VS Code opens the diff in its native diff editor panel.

**Data source:** `file_changed` and `tool_start` WS pushes.

### 📚 Knowledge Library Tab

Browses pi's KB collections and documents.

```
 🔍 [search KB...]

 📁 pi-research-library
    ├─ doc: context-management
    └─ doc: usage-recorder
 📁 pi-context-manager
 📁 pi-deep-research
 📁 pi-web-access
```

**Search:** Text input sends `kb_search` query via WS → results displayed in tree.

**Click a doc:** Sends `kb_open` via WS → pi-bridge returns content → opens in VS Code editor as read-only markdown.

**Data source:** `kb_collections` WS push on connect, `kb_search` response on query.

### 🧠 Skills & Commands Tab

Lists loaded skills with descriptions.

```
 /brainstorming
   Explore user intent, requirements, and design
 /csv-export
   Export tabular data to CSV files
 /grill-with-docs
   Stress-test plans against documentation
```

**Click a skill:** Opens `SKILL.md` in editor.

**Right-click → Run command:** Injects `/skill:name` into pi terminal.

**Data source:** `skills` WS push on connect (from pi's loaded skill registry).

### 📊 Activity Tab

Live session statistics.

```
 🟢 Status: idle
 📦 Model: claude-sonnet-4
 🧠 Thinking: medium
 🔧 Tools: 7 active

 📈 This session:
    Input: 2,401 tokens
    Output: 1,832 tokens
    Cost: $0.12
    Turns: 8
    Tool calls: 23

 💾 Session: feat-auth
    47 entries · 3 branches
```

**Data source:** `state` WS push (updated on every agent_start, agent_end, model_select, thinking_level_select, turn_end).

---

## Launch & Connection Flow

```
1. User runs "pi: Start" command (or workspace opens with auto-run)
2. VS Code extension opens integrated terminal, runs:
   pi --session-dir "<workspace>/.pi/sessions" --cwd "<workspace>"
3. pi loads extensions including pi-bridge
4. pi-bridge on session_start:
   a. Starts WebSocket server on random available port
   b. Writes {"port": 58923, "pid": 12345} to ~/.pi/agent/.pi-bridge-port
   c. Subscribes to pi events
5. VS Code extension polls for port file (max 5s timeout)
6. Connects ws://127.0.0.1:PORT
7. pi-bridge sends initial state dump on connect
8. Sidebar populates, status bar goes green 🟢
```

### Auto-Launch via VS Code Workspace

The extension registers a task with `"runOn": "folderOpen"` to auto-start pi.

Users can create a **VS Code Profile** for pi that:
- Includes only essential extensions (pi, GitLens, theme)
- Opens pi sidebar on startup
- Optionally hides default file explorer

---

## Status Bar

```
🟢 pi: claude-sonnet-4 | ↑2.4k ↓1.8k $0.12 | feat-auth
```

- **Green** when pi is connected and idle
- **Yellow spinner** when pi is streaming
- **Red** when disconnected or error
- Click → command palette: Start, Stop, New Session, Fork, etc.

---

## Commands (Ctrl+Shift+P)

| Command | Action |
|---------|--------|
| `pi: Start` | Launch pi in terminal, connect sidebar |
| `pi: Stop` | Shutdown via WS then Ctrl+C terminal |
| `pi: New Session` | Send `/new` to terminal |
| `pi: Fork Here` | Fork from selected session tree entry |
| `pi: Show Diff` | Open git diff for selected file |
| `pi: Open KB Doc` | Open KB document in editor |
| `pi: Inspect Skill` | Open SKILL.md for selected skill |
| `pi: Run Skill` | Inject `/skill:name` into terminal |

---

## File Diff Strategy

**Git diff only.** When pi modifies a file via `edit` or `write`:

1. pi-bridge pushes `file_changed` event
2. File appears in 📝 Files tab with status (M/A/D)
3. User clicks file
4. Extension runs `git diff <path>` in workspace root
5. Result opens in VS Code's native diff editor

This requires the project to be a git repository. If not, the diff command returns empty and the extension shows the file directly.

---

## pi-bridge Extension Details

### Location
```
~/.pi/agent/extensions/pi-bridge/
├── index.ts          # Entry point: registers event listeners, starts WS server
├── server.ts         # WebSocket server (uses 'ws' npm package)
├── protocol.ts       # Message type definitions
└── package.json      # { "dependencies": { "ws": "^8.0" } }
```

### Event Subscriptions

```typescript
pi.on("session_start",  → push state + session_tree + kb_collections + skills)
pi.on("agent_start",    → push state { isStreaming: true })
pi.on("agent_end",      → push state { isStreaming: false, usage }
                          push file_changed for each edit/write in this turn)
pi.on("turn_end",       → push state { tokens, turns })
pi.on("tool_call",      → if edit/write: push tool_start)
pi.on("tool_result",    → if edit/write: push file_changed)
pi.on("model_select",   → push state { model })
pi.on("thinking_level_select" → push state { thinkingLevel })
pi.on("session_shutdown" → close WS, clean up port file)
```

### Command Handling

Actions that need `ExtensionCommandContext` (fork, resume, session switch) are proxied through registered commands. pi-bridge registers hidden commands that the WS handler triggers via `pi.sendUserMessage()`:

```typescript
// Registered proxy commands (not exposed to user):
pi.registerCommand("pi-bridge-fork", {
  handler: async (args, ctx) => {
    const { entryId } = JSON.parse(args);
    await ctx.fork(entryId);
  },
});

pi.registerCommand("pi-bridge-resume", {
  handler: async (args, ctx) => {
    const { sessionFile } = JSON.parse(args);
    await ctx.switchSession(sessionFile);
  },
});
```

```typescript
// On WS message from VS Code:
switch (msg.type) {
  case "fork":
    pi.sendUserMessage(`/pi-bridge-fork ${JSON.stringify({ entryId: msg.entryId })}`,
      { deliverAs: "followUp" });
    break;
  case "resume":
    pi.sendUserMessage(`/pi-bridge-resume ${JSON.stringify({ sessionFile: msg.sessionFile })}`,
      { deliverAs: "followUp" });
    break;
  case "kb_open":  result = await kb_open(msg.docId); reply with content; break;
  case "diff":     result = await pi.exec("git", ["diff", msg.path]); reply with result; break;
  case "command":  pi.sendUserMessage(msg.command, { deliverAs: "steer" }); break;
}
```

Fork and resume use `followUp` delivery (wait for agent idle) because they trigger session replacement which requires a quiesced agent.

---

## VS Code Extension Details

### Package Structure
```
pi-vscode/
├── package.json       # VS Code extension manifest
├── src/
│   ├── extension.ts   # activate/deactivate
│   ├── sidebar.ts     # TreeDataProvider implementations
│   ├── bridge.ts      # WebSocket client
│   ├── terminal.ts    # Terminal management
│   ├── statusBar.ts   # Status bar item
│   ├── commands.ts    # Command registrations
│   └── types.ts       # Shared types
├── tsconfig.json
└── .vscodeignore
```

### Key VS Code APIs Used

| API | Purpose |
|-----|---------|
| `window.registerTreeDataProvider` | Sidebar views (Sessions, Files, KB, Skills, Stats) |
| `window.createTerminal` | Launch pi in integrated terminal |
| `window.createStatusBarItem` | Status bar with live stats |
| `commands.registerCommand` | Command palette entries |
| `window.showTextDocument` / `commands.executeCommand('vscode.diff')` | Open diffs and docs |
| `tasks.onDidEndTask` | Detect pi shutdown |

### Activation Events
- `onCommand:pi.start`
- `onStartupFinished` (if workspace has pi config)
- `workspaceContains:.pi/bridge` (optional)

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| pi not started, sidebar clicked | Show "pi not running — Start?" prompt |
| WS connection lost | Attempt reconnect (3 retries, 2s backoff). Show red status bar. |
| pi-bridge not loaded | Port file never appears. Show "pi-bridge extension not found. Install to ~/.pi/agent/extensions/pi-bridge/" |
| Port file stale (old PID dead) | Ignore, wait for new port file |
| Command fails (e.g., fork on invalid entryId) | Push error back to VS Code, show notification |
| Session switch mid-stream | Queue command until idle |
| VS Code closes | Send shutdown via WS, clean up |

---

## Dependencies

### pi-bridge (npm)
- `ws` — WebSocket server

### VS Code Extension (npm)
- `ws` — WebSocket client
- None other — uses VS Code built-in APIs

---

## What This Does NOT Cover

- **pi TUI customization** — pi runs unmodified in the terminal. The extension observes and supplements.
- **Multi-window pi** — one pi instance per workspace.
- **Remote pi** — only local pi instances (same machine).
- **Cross-session file history** — file changes are tracked per session. Historical tracking across all sessions is a future enhancement.
- **Non-git diffs** — if the workspace is not a git repo, file changes are listed but diffs are not available (file opens directly).

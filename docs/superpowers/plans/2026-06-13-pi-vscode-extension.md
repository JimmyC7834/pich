# pi VS Code Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code extension + pi-bridge companion that gives pi an IDE-aware sidebar with session tree, file change diffing, KB browsing, skills inspection, and live stats.

**Architecture:** Two components communicate over a local WebSocket. pi-bridge (`~/.pi/agent/extensions/pi-bridge/`) runs inside pi and exposes events/commands over `ws://127.0.0.1:RANDOM`. The VS Code extension (`~/.pi/pi-vscode/`) connects as a client and renders sidebar TreeViews.

**Tech Stack:** TypeScript, `ws` (WebSocket), VS Code Extension API, pi Extension API (`@earendil-works/pi-coding-agent`)

---

## File Structure

```
~/.pi/
├── agent/extensions/pi-bridge/        # pi extension (Part A)
│   ├── package.json
│   ├── package-lock.json
│   └── src/
│       ├── index.ts                   # Entry point: event subscriptions, WS server startup
│       ├── protocol.ts               # WS message type definitions (shared contract)
│       ├── server.ts                 # WebSocket server: bind, broadcast, handle commands
│       └── commands.ts               # Proxy commands for fork/resume (needs ExtensionCommandContext)
│
└── pi-vscode/                         # VS Code extension (Part B)
    ├── package.json                   # Extension manifest
    ├── tsconfig.json
    ├── .vscodeignore
    └── src/
        ├── extension.ts              # activate/deactivate entry
        ├── types.ts                  # Protocol types (mirrors pi-bridge protocol.ts)
        ├── bridge.ts                 # WebSocket client: connect, reconnect, send, receive
        ├── store.ts                  # Reactive state store (model, tokens, sessions, files, KB, skills)
        ├── terminal.ts              # Terminal manager: launch pi, stop, inject commands
        ├── statusBar.ts             # Status bar item
        ├── commands.ts              # Command palette registrations
        └── sidebar/
            ├── sessions.ts          # Sessions TreeDataProvider
            ├── files.ts             # Files TreeDataProvider + git diff
            ├── kb.ts                # KB TreeDataProvider + search
            ├── skills.ts            # Skills TreeDataProvider
            └── stats.ts             # Stats WebviewProvider
```

**Boundaries:**
- `protocol.ts` is the shared contract — both sides import the same type shapes. pi-bridge owns it as the server; VS Code mirrors it as `types.ts`.
- `store.ts` is the single reactive state hub for the VS Code extension. Every sidebar view reads from it. `bridge.ts` writes to it. No view talks directly to the WebSocket.
- `server.ts` handles WebSocket lifecycle and broadcasting. `index.ts` owns pi event subscriptions and calls into `server.ts` to push.
- `commands.ts` (pi-bridge) owns the proxy commands that wrap `ctx.fork()` / `ctx.switchSession()`.

---

## Shared Protocol (source of truth: pi-bridge `protocol.ts`)

```typescript
// ── pi-bridge → VS Code (push events) ──

type PiToVSCode =
  | { type: "state"; data: PiState }
  | { type: "session_tree"; data: { sessions: SessionInfo[]; active: string } }
  | { type: "kb_collections"; data: { collections: KBCollection[] } }
  | { type: "file_changed"; data: { path: string; status: "M"|"A"|"D"; toolCallId: string } }
  | { type: "tool_start"; data: { toolName: string; toolCallId: string; path: string } }
  | { type: "skills"; data: { name: string; description: string; filePath: string }[] }
  | { type: "error"; data: { message: string } }
  | { type: "response"; id: string; data: unknown };

// ── VS Code → pi-bridge (commands) ──

type VSCodeToPi =
  | { type: "fork"; entryId: string }
  | { type: "resume"; sessionFile: string }
  | { type: "kb_open"; id: string; docId: string }  // id for response correlation
  | { type: "kb_search"; id: string; query: string }
  | { type: "diff"; id: string; path: string }
  | { type: "command"; command: string }
  | { type: "shutdown" };
```

---

## Part A: pi-bridge Extension

### Task A1: Scaffold extension directory + dependencies

**Files:**
- Create: `~/.pi/agent/extensions/pi-bridge/package.json`
- Create: `~/.pi/agent/extensions/pi-bridge/tsconfig.json`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "pi-bridge",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "ws": "^8.18.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install dependencies**

```bash
cd ~/.pi/agent/extensions/pi-bridge && npm install
```

- [ ] **Step 4: Verify** — `ls node_modules/ws/package.json` exists and shows `"ws"`

- [ ] **Step 5: Commit**

```bash
cd ~/.pi
git add agent/extensions/pi-bridge/package.json agent/extensions/pi-bridge/tsconfig.json agent/extensions/pi-bridge/package-lock.json
git commit -m "feat(pi-bridge): scaffold extension with ws dependency"
```

---

### Task A2: Define protocol types

**Files:**
- Create: `~/.pi/agent/extensions/pi-bridge/src/protocol.ts`

- [ ] **Step 1: Write protocol.ts**

```typescript
// ── pi-bridge → VS Code (push events) ──

export interface PiState {
  model?: string;
  thinkingLevel?: string;
  isStreaming: boolean;
  activeTools?: string[];
  tokensInput?: number;
  tokensOutput?: number;
  cost?: number;
  turns?: number;
  toolCalls?: number;
}

export interface SessionInfo {
  id: string;
  parentId?: string;
  role: string;
  type: string;
  children?: SessionInfo[];
}

export interface KBCollection {
  name: string;
  docCount: number;
}

export type PiToVSCode =
  | { type: "state"; data: PiState }
  | { type: "session_tree"; data: { sessions: SessionInfo[]; active: string } }
  | { type: "kb_collections"; data: { collections: KBCollection[] } }
  | { type: "file_changed"; data: { path: string; status: "M" | "A" | "D"; toolCallId: string } }
  | { type: "tool_start"; data: { toolName: string; toolCallId: string; path: string } }
  | { type: "skills"; data: { name: string; description: string; filePath: string }[] }
  | { type: "error"; data: { message: string } }
  | { type: "response"; id: string; data: unknown };

// ── VS Code → pi-bridge (commands) ──

export type VSCodeToPi =
  | { type: "fork"; entryId: string }
  | { type: "resume"; sessionFile: string }
  | { type: "kb_open"; id: string; docId: string }
  | { type: "kb_search"; id: string; query: string }
  | { type: "diff"; id: string; path: string }
  | { type: "command"; command: string }
  | { type: "shutdown" };

export function isVSCodeToPi(msg: unknown): msg is VSCodeToPi {
  return typeof msg === "object" && msg !== null && "type" in msg;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/.pi/agent/extensions/pi-bridge && npx tsc --noEmit src/protocol.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add agent/extensions/pi-bridge/src/protocol.ts
git commit -m "feat(pi-bridge): add WebSocket protocol types"
```

---

### Task A3: Build WebSocket server

**Files:**
- Create: `~/.pi/agent/extensions/pi-bridge/src/server.ts`

- [ ] **Step 1: Write server.ts**

```typescript
import { WebSocketServer, WebSocket } from "ws";
import type { PiToVSCode, VSCodeToPi, PiState } from "./protocol";
import { isVSCodeToPi } from "./protocol";
import { createServer } from "node:net";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT_FILE = join(homedir(), ".pi", "agent", ".pi-bridge-port");

export interface BridgeServerCallbacks {
  onCommand: (msg: VSCodeToPi, reply: (response: PiToVSCode) => void) => Promise<void>;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private port = 0;
  private callbacks: BridgeServerCallbacks;

  constructor(callbacks: BridgeServerCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<number> {
    this.port = await findFreePort();

    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.port,
    });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (!isVSCodeToPi(msg)) return;

          switch (msg.type) {
            case "shutdown":
              await this.stop();
              break;
            default:
              await this.callbacks.onCommand(msg, (response) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(response));
                }
              });
          }
        } catch {}
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });

      ws.on("error", () => {
        this.clients.delete(ws);
      });
    });

    this.wss.on("error", () => {});

    // Write port file so VS Code can discover us
    writeFileSync(PORT_FILE, JSON.stringify({ port: this.port, pid: process.pid }));

    return this.port;
  }

  /** Push an event to all connected clients */
  broadcast(event: PiToVSCode): void {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      this.wss?.close(() => {
        this.wss = null;
        // Clean up port file
        try { unlinkSync(PORT_FILE); } catch {}
        resolve();
      });
    });
  }
}

/** Find a random free port on localhost */
function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "string" ? 0 : addr?.port ?? 0;
      server.close(() => resolve(port));
    });
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/.pi/agent/extensions/pi-bridge && npx tsc --noEmit src/server.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add agent/extensions/pi-bridge/src/server.ts
git commit -m "feat(pi-bridge): add WebSocket server with port discovery"
```

---

### Task A4: Register proxy commands for fork/resume

**Files:**
- Create: `~/.pi/agent/extensions/pi-bridge/src/commands.ts`

- [ ] **Step 1: Write commands.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Register hidden commands that proxy ExtensionCommandContext-only APIs
 * (fork, resume/session-switch) so the WS server can trigger them.
 */
export function registerProxyCommands(pi: ExtensionAPI): void {
  pi.registerCommand("pi-bridge-fork", {
    description: "[internal] Fork session from an entry",
    handler: async (args, ctx) => {
      const { entryId } = JSON.parse(args) as { entryId: string };
      await ctx.fork(entryId);
    },
  });

  pi.registerCommand("pi-bridge-resume", {
    description: "[internal] Resume a saved session",
    handler: async (args, ctx) => {
      const { sessionFile } = JSON.parse(args) as { sessionFile: string };
      await ctx.switchSession(sessionFile);
    },
  });

  pi.registerCommand("pi-bridge-kb-open", {
    description: "[internal] Open a KB document",
    handler: async (args, ctx) => {
      const { id } = JSON.parse(args) as { id: string };
      const result = await ctx.sessionManager; // unused here; handled in index.ts
    },
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/.pi/agent/extensions/pi-bridge && npx tsc --noEmit src/commands.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add agent/extensions/pi-bridge/src/commands.ts
git commit -m "feat(pi-bridge): add proxy commands for fork and resume"
```

---

### Task A5: Wire up entry point (index.ts)

**Files:**
- Create: `~/.pi/agent/extensions/pi-bridge/src/index.ts`

- [ ] **Step 1: Write index.ts**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeServer, type BridgeServerCallbacks } from "./server";
import { registerProxyCommands } from "./commands";
import type { PiToVSCode, VSCodeToPi, SessionInfo } from "./protocol";

export default function (pi: ExtensionAPI) {
  // ── State tracking ──
  let state = {
    model: "",
    thinkingLevel: "off",
    isStreaming: false,
    activeTools: [] as string[],
    tokensInput: 0,
    tokensOutput: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
  };

  let trackedFiles = new Map<string, { status: "M" | "A" | "D"; toolCallId: string }>();
  let pendingFiles: Array<{ path: string; status: "M" | "A" | "D"; toolCallId: string }> = [];

  // ── Register proxy commands (fork, resume) ──
  registerProxyCommands(pi);

  // ── Command handler for WS messages ──
  const commandHandler: BridgeServerCallbacks["onCommand"] = async (msg, reply) => {
    switch (msg.type) {
      case "fork":
        pi.sendUserMessage(
          `/pi-bridge-fork ${JSON.stringify({ entryId: msg.entryId })}`,
          { deliverAs: "followUp" }
        );
        break;
      case "resume":
        pi.sendUserMessage(
          `/pi-bridge-resume ${JSON.stringify({ sessionFile: msg.sessionFile })}`,
          { deliverAs: "followUp" }
        );
        break;
      case "kb_open":
        // Use pi's kb tools if available, or reply with error
        reply({ type: "response", id: msg.id, data: { content: "# Not available\nKB tools are accessible via pi's CLI." } });
        break;
      case "kb_search":
        reply({ type: "response", id: msg.id, data: { results: [] } });
        break;
      case "diff":
        try {
          const result = await pi.exec("git", ["diff", msg.path], { timeout: 5000 });
          reply({ type: "response", id: msg.id, data: { diff: result.stdout } });
        } catch {
          reply({ type: "response", id: msg.id, data: { diff: "" } });
        }
        break;
      case "command":
        pi.sendUserMessage(msg.command, { deliverAs: "steer" });
        break;
    }
  };

  const server = new BridgeServer({ onCommand: commandHandler });

  // ── Event subscriptions ──

  pi.on("session_start", async (event, ctx) => {
    await server.start();

    // Push initial state
    state.model = ctx.model?.id ?? "";
    state.thinkingLevel = pi.getThinkingLevel();
    state.activeTools = pi.getActiveTools();

    server.broadcast({ type: "state", data: { ...state } });

    // Push session tree
    try {
      const branch = ctx.sessionManager.getTree();
      const sessions = []; // Simplified — build tree from entries
      server.broadcast({ type: "session_tree", data: { sessions, active: ctx.sessionManager.getLeafId() ?? "" } });
    } catch {}

    // Push skills
    try {
      const commands = pi.getCommands?.() ?? [];
      const skillItems = commands
        .filter((c: { source: string }) => c.source === "skill")
        .map((c: { name: string; description?: string; sourceInfo: { path: string } }) => ({
          name: c.name,
          description: c.description ?? "",
          filePath: c.sourceInfo.path,
        }));
      server.broadcast({ type: "skills", data: skillItems });
    } catch {}

    // Push KB collections
    try {
      // kb_collections is a tool — we'll query it if available
      server.broadcast({ type: "kb_collections", data: { collections: [] } });
    } catch {}
  });

  pi.on("agent_start", () => {
    state.isStreaming = true;
    server.broadcast({ type: "state", data: { isStreaming: true } });
  });

  pi.on("agent_end", (event, ctx) => {
    state.isStreaming = false;

    // Accumulate token usage from new messages
    for (const msg of event.messages) {
      if (msg.role === "assistant" && "usage" in msg) {
        const usage = msg.usage as { input: number; output: number; cost: { total: number } };
        state.tokensInput += usage.input;
        state.tokensOutput += usage.output;
        state.cost += usage.cost.total;
      }
    }

    // Flush pending file changes
    for (const f of pendingFiles) {
      trackedFiles.set(f.path, f);
      server.broadcast({ type: "file_changed", data: f });
    }
    pendingFiles = [];

    server.broadcast({ type: "state", data: { ...state } });
  });

  pi.on("turn_end", () => {
    state.turns++;
    server.broadcast({ type: "state", data: { turns: state.turns } });
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as { path?: string }).path;
      if (path) {
        server.broadcast({
          type: "tool_start",
          data: { toolName: event.toolName, toolCallId: event.toolCallId, path },
        });
      }
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as { path?: string }).path;
      if (path) {
        const status = event.toolName === "write" ? "A" : "M";
        state.toolCalls++;
        pendingFiles.push({ path, status, toolCallId: event.toolCallId });
      }
    }
  });

  pi.on("model_select", (event) => {
    state.model = event.model.id;
    server.broadcast({ type: "state", data: { model: state.model } });
  });

  pi.on("thinking_level_select", (event) => {
    state.thinkingLevel = event.level;
    server.broadcast({ type: "state", data: { thinkingLevel: state.thinkingLevel } });
  });

  pi.on("session_shutdown", async () => {
    server.broadcast({ type: "error", data: { message: "pi shutting down" } });
    await server.stop();
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/.pi/agent/extensions/pi-bridge && npx tsc --noEmit src/index.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add agent/extensions/pi-bridge/src/index.ts
git commit -m "feat(pi-bridge): wire up event subscriptions and WS push"
```

---

### Task A6: End-to-end smoke test of pi-bridge

- [ ] **Step 1: Start pi with the extension**

```bash
pi --cwd ~/.pi
```

- [ ] **Step 2: Check port file was written**

```bash
cat ~/.pi/agent/.pi-bridge-port
```

Expected: `{"port":NNNNN,"pid":NNNNN}` with a valid port number.

- [ ] **Step 3: Connect a test WebSocket client**

In a separate terminal:

```bash
node -e "
const { WebSocket } = require('ws');
const port = JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.pi/agent/.pi-bridge-port', 'utf8')).port;
const ws = new WebSocket('ws://127.0.0.1:' + port);
ws.on('open', () => console.log('connected'));
ws.on('message', (d) => console.log('<<', d.toString()));
"
```

Expected: `connected` followed by `{"type":"skills",...}` and `{"type":"kb_collections",...}` messages.

- [ ] **Step 4: Send a diff command from the test client**

Send: `{"type":"diff","id":"test-1","path":"README.md"}`

Expected: response with diff content.

- [ ] **Step 5: Stop pi and verify port file is cleaned up**

Close pi. Run `cat ~/.pi/agent/.pi-bridge-port`. Expected: file does not exist.

- [ ] **Step 6: Commit** (if changes were made during debugging)

---

## Part B: VS Code Extension

### Task B1: Scaffold VS Code extension

**Files:**
- Create: `~/.pi/pi-vscode/package.json`
- Create: `~/.pi/pi-vscode/tsconfig.json`
- Create: `~/.pi/pi-vscode/.vscodeignore`

- [ ] **Step 1: Create directory**

```bash
mkdir -p ~/.pi/pi-vscode/src/sidebar
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "pi-vscode",
  "displayName": "pi",
  "description": "IDE sidebar companion for pi coding agent",
  "version": "0.1.0",
  "publisher": "pi",
  "engines": {
    "vscode": "^1.90.0"
  },
  "categories": ["Other"],
  "activationEvents": [
    "onCommand:pi.start",
    "onView:pi-sessions",
    "onView:pi-files",
    "onView:pi-kb",
    "onView:pi-skills",
    "onView:pi-stats"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "pi.start", "title": "pi: Start" },
      { "command": "pi.stop", "title": "pi: Stop" },
      { "command": "pi.newSession", "title": "pi: New Session" },
      { "command": "pi.forkSession", "title": "pi: Fork Here" },
      { "command": "pi.resumeSession", "title": "pi: Resume Session" },
      { "command": "pi.showDiff", "title": "pi: Show Diff" },
      { "command": "pi.openKBDoc", "title": "pi: Open KB Document" },
      { "command": "pi.inspectSkill", "title": "pi: Inspect Skill" },
      { "command": "pi.runSkill", "title": "pi: Run Skill" }
    ],
    "viewsContainers": {
      "activitybar": [
        {
          "id": "pi-sidebar",
          "title": "pi",
          "icon": "$(hubot)"
        }
      ]
    },
    "views": {
      "pi-sidebar": [
        { "id": "pi-sessions", "name": "Sessions", "icon": "$(git-branch)" },
        { "id": "pi-files", "name": "Files", "icon": "$(diff)" },
        { "id": "pi-kb", "name": "Knowledge Library", "icon": "$(book)" },
        { "id": "pi-skills", "name": "Skills", "icon": "$(wand)" },
        { "id": "pi-stats", "name": "Stats", "icon": "$(pulse)" }
      ]
    },
    "menus": {
      "view/title": [
        {
          "command": "pi.start",
          "when": "view == pi-sessions",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "pi.forkSession",
          "when": "view == pi-sessions && viewItem == branch",
          "group": "inline"
        },
        {
          "command": "pi.resumeSession",
          "when": "view == pi-sessions && viewItem == branch",
          "group": "inline"
        }
      ]
    }
  },
  "scripts": {
    "vscode:prepublish": "npx tsc -p tsconfig.json",
    "compile": "npx tsc -p tsconfig.json",
    "watch": "npx tsc -watch -p tsconfig.json"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/vscode": "^1.90.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "out",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "out"]
}
```

- [ ] **Step 4: Write .vscodeignore**

```
.vscode/**
src/**
node_modules/**
tsconfig.json
.gitignore
```

- [ ] **Step 5: Install dependencies**

```bash
cd ~/.pi/pi-vscode && npm install
```

- [ ] **Step 6: Verify compilation**

```bash
cd ~/.pi/pi-vscode && mkdir -p out && echo 'export function activate() {}' > src/extension.ts && npx tsc --noEmit
```

Expected: `src/extension.ts` has no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/.pi
git add pi-vscode/package.json pi-vscode/tsconfig.json pi-vscode/.vscodeignore pi-vscode/package-lock.json
git commit -m "feat(pi-vscode): scaffold VS Code extension"
```

---

### Task B2: Protocol types (mirroring pi-bridge)

**Files:**
- Create: `~/.pi/pi-vscode/src/types.ts`

- [ ] **Step 1: Write types.ts** (mirrors pi-bridge protocol.ts)

```typescript
export interface PiState {
  model?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  activeTools?: string[];
  tokensInput?: number;
  tokensOutput?: number;
  cost?: number;
  turns?: number;
  toolCalls?: number;
}

export interface SessionInfo {
  id: string;
  parentId?: string;
  role: string;
  type: string;
  children?: SessionInfo[];
}

export interface KBCollection {
  name: string;
  docCount: number;
}

export interface SkillItem {
  name: string;
  description: string;
  filePath: string;
}

export interface FileChange {
  path: string;
  status: "M" | "A" | "D";
  toolCallId: string;
}

// ── pi-bridge → VS Code ──
type PiMessage = { type: "state"; data: Partial<PiState> }
  | { type: "session_tree"; data: { sessions: SessionInfo[]; active: string } }
  | { type: "kb_collections"; data: { collections: KBCollection[] } }
  | { type: "file_changed"; data: FileChange }
  | { type: "tool_start"; data: { toolName: string; toolCallId: string; path: string } }
  | { type: "skills"; data: SkillItem[] }
  | { type: "error"; data: { message: string } }
  | { type: "response"; id: string; data: unknown };

// ── VS Code → pi-bridge ──
type CommandMessage = { type: "fork"; entryId: string }
  | { type: "resume"; sessionFile: string }
  | { type: "kb_open"; id: string; docId: string }
  | { type: "kb_search"; id: string; query: string }
  | { type: "diff"; id: string; path: string }
  | { type: "command"; command: string }
  | { type: "shutdown" };
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/.pi/pi-vscode && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/types.ts
git commit -m "feat(pi-vscode): add protocol types"
```

---

### Task B3: WebSocket bridge client

**Files:**
- Create: `~/.pi/pi-vscode/src/bridge.ts`

- [ ] **Step 1: Write bridge.ts**

```typescript
import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type { PiState, SessionInfo, KBCollection, SkillItem, FileChange } from "./types";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT_FILE = join(homedir(), ".pi", "agent", ".pi-bridge-port");

export interface PiBridgeEvents {
  connected: [];
  disconnected: [reason: string];
  state: [data: Partial<PiState>];
  sessionTree: [data: { sessions: SessionInfo[]; active: string }];
  kbCollections: [data: { collections: KBCollection[] }];
  fileChanged: [data: FileChange];
  skills: [skills: SkillItem[]];
  error: [message: string];
}

export class PiBridge extends EventEmitter<PiBridgeEvents> {
  private ws: WebSocket | null = null;
  private replyId = 0;

  /** Try to discover pi-bridge port from port file and connect */
  async connect(maxWaitMs = 5000): Promise<void> {
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const attempt = () => {
        const port = this.readPortFile();
        if (!port) {
          if (Date.now() - start > maxWaitMs) {
            return reject(new Error("pi-bridge port file not found. Is pi running with pi-bridge extension?"));
          }
          return setTimeout(attempt, 200);
        }

        try {
          this.ws = new WebSocket(`ws://127.0.0.1:${port}`);

          this.ws.on("open", () => {
            this.emit("connected");
            resolve();
          });

          this.ws.on("message", (raw) => {
            try {
              const msg = JSON.parse(raw.toString());
              this.handleMessage(msg);
            } catch {}
          });

          this.ws.on("close", (code) => {
            this.emit("disconnected", `WebSocket closed (code ${code})`);
            this.ws = null;
          });

          this.ws.on("error", (err) => {
            if (Date.now() - start > maxWaitMs) {
              this.emit("disconnected", err.message);
              this.ws = null;
            }
          });
        } catch (err) {
          const e = err as Error;
          if (Date.now() - start > maxWaitMs) {
            return reject(new Error(`Failed to connect pi-bridge: ${e.message}`));
          }
          setTimeout(attempt, 200);
        }
      };

      attempt();
    });
  }

  /** Send a command and wait for a response */
  async send(cmd: { type: string; [k: string]: unknown }, expectReply = true): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to pi-bridge");
    }

    if (expectReply) {
      const id = `req-${++this.replyId}`;
      (cmd as Record<string, unknown>).id = id;
      const response = await this.waitForReply(id);
      this.ws.send(JSON.stringify(cmd));
      return response;
    }

    this.ws.send(JSON.stringify(cmd));
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Private ──

  private readPortFile(): number | null {
    try {
      if (!existsSync(PORT_FILE)) return null;
      const { port, pid } = JSON.parse(readFileSync(PORT_FILE, "utf8"));
      // Check if the process is still alive
      try { process.kill(pid, 0); } catch { return null; }
      return port ?? null;
    } catch {
      return null;
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "state": this.emit("state", msg.data as Partial<PiState>); break;
      case "session_tree": this.emit("sessionTree", msg.data as { sessions: SessionInfo[]; active: string }); break;
      case "kb_collections": this.emit("kbCollections", msg.data as { collections: KBCollection[] }); break;
      case "file_changed": this.emit("fileChanged", msg.data as FileChange); break;
      case "skills": this.emit("skills", msg.data as SkillItem[]); break;
      case "error": this.emit("error", (msg.data as { message: string }).message); break;
      case "response":
        this.emit(`_response:${msg.id as string}`, msg.data);
        break;
    }
  }

  private waitForReply(id: string): Promise<unknown> {
    return new Promise((resolve) => {
      const handler = (data: unknown) => {
        this.off(`_response:${id}`, handler);
        resolve(data);
      };
      this.on(`_response:${id}`, handler);
    });
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/.pi/pi-vscode && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/bridge.ts
git commit -m "feat(pi-vscode): add WebSocket bridge client"
```

---

### Task B4: Reactive state store

**Files:**
- Create: `~/.pi/pi-vscode/src/store.ts`

- [ ] **Step 1: Write store.ts**

```typescript
import { EventEmitter } from "node:events";
import type { PiState, SessionInfo, KBCollection, SkillItem, FileChange } from "./types";

export interface StoreEvents {
  changed: [];
}

export class PiStore extends EventEmitter<StoreEvents> {
  state: PiState = { isStreaming: false };
  sessions: SessionInfo[] = [];
  activeSession = "";
  collections: KBCollection[] = [];
  files: FileChange[] = [];
  skills: SkillItem[] = [];

  updateState(partial: Partial<PiState>): void {
    Object.assign(this.state, partial);
    this.emit("changed");
  }

  setSessions(sessions: SessionInfo[], active: string): void {
    this.sessions = sessions;
    this.activeSession = active;
    this.emit("changed");
  }

  setCollections(collections: KBCollection[]): void {
    this.collections = collections;
    this.emit("changed");
  }

  addFileChange(change: FileChange): void {
    // Deduplicate by path (latest wins)
    const idx = this.files.findIndex(f => f.path === change.path);
    if (idx >= 0) this.files.splice(idx, 1);
    this.files.unshift(change);
    this.emit("changed");
  }

  setSkills(skills: SkillItem[]): void {
    this.skills = skills;
    this.emit("changed");
  }

  reset(): void {
    this.state = { isStreaming: false };
    this.sessions = [];
    this.activeSession = "";
    this.collections = [];
    this.files = [];
    this.skills = [];
    this.emit("changed");
  }
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/store.ts
git commit -m "feat(pi-vscode): add reactive state store"
```

---

### Task B5: Terminal manager

**Files:**
- Create: `~/.pi/pi-vscode/src/terminal.ts`

- [ ] **Step 1: Write terminal.ts**

```typescript
import * as vscode from "vscode";

const TERMINAL_NAME = "pi";

export class PiTerminal {
  private terminal: vscode.Terminal | null = null;

  /** Launch pi in a VS Code integrated terminal */
  start(cwd: string): void {
    if (this.terminal) this.terminal.dispose();

    // Detect if pi is available
    this.terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd,
      hideFromUser: false,
    });

    this.terminal.show();
    this.terminal.sendText(`pi --session-dir "${cwd}/.pi/sessions"`, true);
  }

  /** Send text to the pi terminal */
  sendText(text: string): void {
    if (!this.terminal) return;
    this.terminal.show();
    this.terminal.sendText(text, false);
  }

  /** Send a slash command */
  sendCommand(command: string): void {
    this.sendText(command);
  }

  /** Stop pi by sending Ctrl+C */
  stop(): void {
    if (!this.terminal) return;
    // Send Ctrl+C (0x03)
    this.terminal.sendText("\x03");
  }

  dispose(): void {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
  }

  isRunning(): boolean {
    return this.terminal !== null;
  }
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/terminal.ts
git commit -m "feat(pi-vscode): add terminal manager"
```

---

### Task B6: Status bar item

**Files:**
- Create: `~/.pi/pi-vscode/src/statusBar.ts`

- [ ] **Step 1: Write statusBar.ts**

```typescript
import * as vscode from "vscode";
import type { PiStore } from "./store";

export class PiStatusBar {
  private item: vscode.StatusBarItem;

  constructor(private store: PiStore) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = "pi.showActions";

    store.on("changed", () => this.update());
    this.update();
  }

  show(): void {
    this.item.show();
    this.update();
  }

  hide(): void {
    this.item.hide();
  }

  private update(): void {
    const s = this.store.state;

    if (!s.model) {
      this.item.text = "$(circle-slash) pi: disconnected";
      this.item.tooltip = "pi is not connected. Click to start.";
      this.item.backgroundColor = undefined;
      return;
    }

    if (s.isStreaming) {
      this.item.text = "$(loading~spin) pi";
    } else {
      this.item.text = "$(hubot) pi";
    }

    const parts: string[] = [];
    if (s.model) parts.push(s.model);
    if (s.tokensInput != null && s.tokensOutput != null) {
      const inp = s.tokensInput < 1000 ? `${s.tokensInput}` : `${(s.tokensInput / 1000).toFixed(1)}k`;
      const out = s.tokensOutput < 1000 ? `${s.tokensOutput}` : `${(s.tokensOutput / 1000).toFixed(1)}k`;
      parts.push(`↑${inp} ↓${out}`);
    }
    if (s.cost != null) parts.push(`$${s.cost.toFixed(2)}`);

    this.item.text += `: ${parts.join(" | ")}`;
    this.item.tooltip = `Model: ${s.model}\nThinking: ${s.thinkingLevel}\nTurns: ${s.turns}\nTool calls: ${s.toolCalls}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/statusBar.ts
git commit -m "feat(pi-vscode): add status bar item"
```

---

### Task B7: Command registrations

**Files:**
- Create: `~/.pi/pi-vscode/src/commands.ts`

- [ ] **Step 1: Write commands.ts**

```typescript
import * as vscode from "vscode";
import type { PiBridge } from "./bridge";
import type { PiTerminal } from "./terminal";

export function registerCommands(
  context: vscode.ExtensionContext,
  bridge: PiBridge,
  terminal: PiTerminal
): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const register = (command: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));

  register("pi.start", () => terminal.start(cwd));
  register("pi.stop", async () => {
    await bridge.send({ type: "shutdown" }, false).catch(() => {});
    terminal.stop();
  });
  register("pi.newSession", () => terminal.sendCommand("/new"));
  register("pi.forkSession", (entry: { id: string }) => {
    if (entry?.id) bridge.send({ type: "fork", entryId: entry.id }, false);
  });
  register("pi.resumeSession", (entry: { sessionFile: string }) => {
    if (entry?.sessionFile) bridge.send({ type: "resume", sessionFile: entry.sessionFile }, false);
  });
  register("pi.showDiff", async (file: { path: string }) => {
    if (!file?.path) return;
    const diffResult = await bridge.send({ type: "diff", path: file.path }) as { diff: string };
    if (diffResult?.diff) {
      const doc = await vscode.workspace.openTextDocument({ content: diffResult.diff, language: "diff" });
      await vscode.window.showTextDocument(doc);
    } else {
      // No diff available, just open the file
      const uri = vscode.Uri.file(file.path);
      await vscode.window.showTextDocument(uri);
    }
  });
  register("pi.openKBDoc", async (doc: { docId: string }) => {
    if (!doc?.docId) return;
    const result = await bridge.send({ type: "kb_open", docId: doc.docId }) as { content?: string };
    if (result?.content) {
      const doc = await vscode.workspace.openTextDocument({ content: result.content, language: "markdown" });
      await vscode.window.showTextDocument(doc);
    }
  });
  register("pi.inspectSkill", async (skill: { filePath: string }) => {
    if (!skill?.filePath) return;
    const uri = vscode.Uri.file(skill.filePath);
    await vscode.window.showTextDocument(uri);
  });
  register("pi.runSkill", (skill: { name: string }) => {
    if (!skill?.name) return;
    terminal.sendCommand(`/skill:${skill.name}`);
  });

  // Show actions palette when status bar is clicked
  register("pi.showActions", async () => {
    const connected = bridge.isConnected();
    const choice = await vscode.window.showQuickPick(
      connected
        ? [
            { label: "$(debug-stop) Stop pi", action: "stop" },
            { label: "$(add) New Session", action: "new" },
          ]
        : [
            { label: "$(debug-start) Start pi", action: "start" },
          ],
      { placeHolder: "pi actions" }
    );
    if (!choice) return;
    if (choice.action === "start") vscode.commands.executeCommand("pi.start");
    if (choice.action === "stop") vscode.commands.executeCommand("pi.stop");
    if (choice.action === "new") vscode.commands.executeCommand("pi.newSession");
  });
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/commands.ts
git commit -m "feat(pi-vscode): add command registrations"
```

---

### Task B8: Sidebar — Sessions TreeDataProvider

**Files:**
- Create: `~/.pi/pi-vscode/src/sidebar/sessions.ts`

- [ ] **Step 1: Write sessions.ts**

```typescript
import * as vscode from "vscode";
import type { PiStore } from "../store";
import type { SessionInfo } from "../types";

export class SessionsProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private store: PiStore) {
    store.on("changed", () => this._onDidChange.fire());
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeItem): SessionTreeItem[] {
    if (element) {
      // Children of a session node
      return (element.session.children ?? []).map(s => new SessionTreeItem(s));
    }
    // Root — top-level sessions
    return this.store.sessions.map(s => new SessionTreeItem(s));
  }

  refresh(): void {
    this._onDidChange.fire();
  }
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(readonly session: SessionInfo) {
    const label = session.role === "user"
      ? session.type?.slice(0, 50) ?? session.id.slice(0, 8)
      : session.id.slice(0, 8);

    super(
      label,
      session.children && session.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.description = session.role;
    this.contextValue = "branch";
    this.tooltip = `ID: ${session.id}\nRole: ${session.role}`;

    // Use the session id as the command argument for fork/resume
    this.command = undefined; // Handled via context menu
  }
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/sidebar/sessions.ts
git commit -m "feat(pi-vscode): add sessions TreeDataProvider"
```

---

### Task B9: Sidebar — Files TreeDataProvider

**Files:**
- Create: `~/.pi/pi-vscode/src/sidebar/files.ts`

- [ ] **Step 1: Write files.ts**

```typescript
import * as vscode from "vscode";
import type { PiStore } from "../store";
import type { FileChange } from "../types";

export class FilesProvider implements vscode.TreeDataProvider<FileTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private store: PiStore) {
    store.on("changed", () => this._onDidChange.fire());
  }

  getTreeItem(element: FileTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileTreeItem): FileTreeItem[] {
    if (element) return [];

    const items: FileTreeItem[] = [];
    for (const f of this.store.files) {
      items.push(new FileTreeItem(f));
    }
    return items;
  }

  refresh(): void {
    this._onDidChange.fire();
  }
}

class FileTreeItem extends vscode.TreeItem {
  constructor(readonly file: FileChange) {
    super(file.path);

    this.description = `(${file.status})`;
    this.contextValue = "file";
    this.tooltip = `Status: ${file.status}\nTool: ${file.toolCallId}`;

    switch (file.status) {
      case "M":
        this.iconPath = new vscode.ThemeIcon("edit");
        break;
      case "A":
        this.iconPath = new vscode.ThemeIcon("add");
        break;
      case "D":
        this.iconPath = new vscode.ThemeIcon("trash");
        break;
    }

    this.command = {
      command: "pi.showDiff",
      title: "Show Diff",
      arguments: [{ path: file.path }],
    };
  }
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/sidebar/files.ts
git commit -m "feat(pi-vscode): add files TreeDataProvider"
```

---

### Task B10: Sidebar — KB TreeDataProvider

**Files:**
- Create: `~/.pi/pi-vscode/src/sidebar/kb.ts`

- [ ] **Step 1: Write kb.ts**

```typescript
import * as vscode from "vscode";
import type { PiStore } from "../store";
import type { KBCollection } from "../types";

export class KBProvider implements vscode.TreeDataProvider<KBTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private store: PiStore) {
    store.on("changed", () => this._onDidChange.fire());
  }

  getTreeItem(element: KBTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: KBTreeItem): KBTreeItem[] {
    if (element) return [];
    return this.store.collections.map(c => new KBTreeItem(c));
  }

  refresh(): void {
    this._onDidChange.fire();
  }
}

class KBTreeItem extends vscode.TreeItem {
  constructor(readonly collection: KBCollection) {
    super(collection.name, vscode.TreeItemCollapsibleState.None);

    this.iconPath = new vscode.ThemeIcon("folder-library");
    this.description = `${collection.docCount} docs`;
    this.contextValue = "kbCollection";
    this.tooltip = `${collection.name}\n${collection.docCount} documents`;
  }
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/sidebar/kb.ts
git commit -m "feat(pi-vscode): add KB TreeDataProvider"
```

---

### Task B11: Sidebar — Skills TreeDataProvider

**Files:**
- Create: `~/.pi/pi-vscode/src/sidebar/skills.ts`

- [ ] **Step 1: Write skills.ts**

```typescript
import * as vscode from "vscode";
import type { PiStore } from "../store";
import type { SkillItem } from "../types";

export class SkillsProvider implements vscode.TreeDataProvider<SkillTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private store: PiStore) {
    store.on("changed", () => this._onDidChange.fire());
  }

  getTreeItem(element: SkillTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SkillTreeItem): SkillTreeItem[] {
    if (element) return [];
    return this.store.skills.map(s => new SkillTreeItem(s));
  }

  refresh(): void {
    this._onDidChange.fire();
  }
}

class SkillTreeItem extends vscode.TreeItem {
  constructor(readonly skill: SkillItem) {
    super(skill.name, vscode.TreeItemCollapsibleState.None);

    this.description = skill.description;
    this.iconPath = new vscode.ThemeIcon("wand");
    this.contextValue = "skill";
    this.tooltip = `${skill.name}\n${skill.description}\nFile: ${skill.filePath}`;

    this.command = {
      command: "pi.inspectSkill",
      title: "Inspect Skill",
      arguments: [{ filePath: skill.filePath }],
    };
  }
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/sidebar/skills.ts
git commit -m "feat(pi-vscode): add skills TreeDataProvider"
```

---

### Task B12: Sidebar — Stats WebviewProvider

**Files:**
- Create: `~/.pi/pi-vscode/src/sidebar/stats.ts`

- [ ] **Step 1: Write stats.ts** — a simple Webview showing live stats

```typescript
import * as vscode from "vscode";
import type { PiStore } from "../store";

export class StatsProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | null = null;

  constructor(private store: PiStore) {
    store.on("changed", () => this.update());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();
    this.update();
  }

  private update(): void {
    if (!this._view) return;

    const s = this.store.state;
    this._view.webview.postMessage({
      status: s.isStreaming ? "streaming" : (s.model ? "idle" : "disconnected"),
      model: s.model ?? "—",
      thinkingLevel: s.thinkingLevel ?? "—",
      tools: s.activeTools?.length ?? 0,
      tokensInput: formatTokens(s.tokensInput ?? 0),
      tokensOutput: formatTokens(s.tokensOutput ?? 0),
      cost: s.cost != null ? `$${s.cost.toFixed(3)}` : "—",
      turns: s.turns ?? 0,
      toolCalls: s.toolCalls ?? 0,
      session: this.store.activeSession || "—",
      fileCount: this.store.files.length,
      skillCount: this.store.skills.length,
      kbCount: this.store.collections.length,
    });
  }

  private getHtml(): string {
    return `
<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-editor-font-family); padding: 12px; color: var(--vscode-editor-foreground); font-size: 12px; }
  .section { margin-bottom: 16px; }
  .label { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; margin-bottom: 4px; }
  .value { font-weight: 500; }
  .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; }
  .dot.idle { background: #4ec9b0; }
  .dot.streaming { background: #dcdcaa; animation: pulse 1s infinite; }
  .dot.disconnected { background: #f48771; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
</style></head><body>
  <div class="section">
    <div class="label">Status</div>
    <div id="status"><span class="dot disconnected"></span> disconnected</div>
  </div>
  <div class="section">
    <div class="label">Model & Thinking</div>
    <div><span id="model">—</span> · <span id="thinking">—</span></div>
    <div id="tools" style="color:var(--vscode-descriptionForeground)">— active tools</div>
  </div>
  <div class="section">
    <div class="label">Tokens & Cost</div>
    <div class="row"><span>Input</span><span id="input">—</span></div>
    <div class="row"><span>Output</span><span id="output">—</span></div>
    <div class="row"><span>Cost</span><span id="cost">—</span></div>
  </div>
  <div class="section">
    <div class="label">Activity</div>
    <div class="row"><span>Turns</span><span id="turns">0</span></div>
    <div class="row"><span>Tool calls</span><span id="toolCalls">0</span></div>
  </div>
  <div class="section">
    <div class="label">Session</div>
    <div><span id="session">—</span></div>
    <div style="color:var(--vscode-descriptionForeground)"><span id="fileCount">0</span> files · <span id="skillCount">0</span> skills · <span id="kbCount">0</span> KB collections</div>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    window.addEventListener('message', (e) => {
      const d = e.data;
      const dot = d.status === 'idle' ? 'idle' : d.status === 'streaming' ? 'streaming' : 'disconnected';
      $('status').innerHTML = \`<span class="dot \${dot}"></span> \${d.status}\`;
      $('model').textContent = d.model;
      $('thinking').textContent = d.thinkingLevel;
      $('tools').textContent = d.tools + ' active tools';
      $('input').textContent = d.tokensInput;
      $('output').textContent = d.tokensOutput;
      $('cost').textContent = d.cost;
      $('turns').textContent = d.turns;
      $('toolCalls').textContent = d.toolCalls;
      $('session').textContent = d.session;
      $('fileCount').textContent = d.fileCount;
      $('skillCount').textContent = d.skillCount;
      $('kbCount').textContent = d.kbCount;
    });
  </script>
</body></html>`;
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}
```

- [ ] **Step 2: Verify compilation** — `cd ~/.pi/pi-vscode && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/sidebar/stats.ts
git commit -m "feat(pi-vscode): add stats WebviewProvider"
```

---

### Task B13: Main extension entry point (extension.ts)

**Files:**
- Modify: `~/.pi/pi-vscode/src/extension.ts`

- [ ] **Step 1: Write extension.ts**

```typescript
import * as vscode from "vscode";
import { PiBridge } from "./bridge";
import { PiStore } from "./store";
import { PiTerminal } from "./terminal";
import { PiStatusBar } from "./statusBar";
import { registerCommands } from "./commands";
import { SessionsProvider } from "./sidebar/sessions";
import { FilesProvider } from "./sidebar/files";
import { KBProvider } from "./sidebar/kb";
import { SkillsProvider } from "./sidebar/skills";
import { StatsProvider } from "./sidebar/stats";

export function activate(context: vscode.ExtensionContext) {
  const store = new PiStore();
  const bridge = new PiBridge();
  const terminal = new PiTerminal();

  // ── Wire bridge events → store ──
  bridge.on("connected", () => {
    store.updateState({});
  });

  bridge.on("disconnected", () => {
    store.reset();
  });

  bridge.on("state", (data) => {
    store.updateState(data);
  });

  bridge.on("sessionTree", (data) => {
    store.setSessions(data.sessions, data.active);
  });

  bridge.on("kbCollections", (data) => {
    store.setCollections(data.collections);
  });

  bridge.on("fileChanged", (data) => {
    store.addFileChange(data);
  });

  bridge.on("skills", (skills) => {
    store.setSkills(skills);
  });

  bridge.on("error", (message) => {
    vscode.window.showErrorMessage(`pi: ${message}`);
  });

  // ── Status bar ──
  const statusBar = new PiStatusBar(store);

  // ── Commands ──
  registerCommands(context, bridge, terminal);

  // ── Sidebar views ──
  const sessionsProvider = new SessionsProvider(store);
  const filesProvider = new FilesProvider(store);
  const kbProvider = new KBProvider(store);
  const skillsProvider = new SkillsProvider(store);
  const statsProvider = new StatsProvider(store);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("pi-sessions", sessionsProvider),
    vscode.window.registerTreeDataProvider("pi-files", filesProvider),
    vscode.window.registerTreeDataProvider("pi-kb", kbProvider),
    vscode.window.registerTreeDataProvider("pi-skills", skillsProvider),
    vscode.window.registerWebviewViewProvider("pi-stats", statsProvider),
  );

  // ── Auto-connect when pi.start is run ──
  let connecting = false;
  context.subscriptions.push(
    vscode.commands.registerCommand("pi.start", async () => {
      if (connecting) return;
      connecting = true;

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      terminal.start(cwd);
      statusBar.show();

      try {
        await bridge.connect(8000);
        vscode.window.showInformationMessage("pi connected");
      } catch (e) {
        const err = e as Error;
        vscode.window.showWarningMessage(err.message);
        statusBar.hide();
      } finally {
        connecting = false;
      }
    }),
  );

  // ── Cleanup on deactivate ──
  context.subscriptions.push({
    dispose: () => {
      bridge.disconnect();
      terminal.dispose();
      statusBar.dispose();
    },
  });
}

export function deactivate() {}
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/.pi/pi-vscode && npx tsc --noEmit
```

Expected: no errors. If there are issues with `EventEmitter` import from `node:events`, add `{ emitter: EventEmitter }` to `tsconfig.json` `compilerOptions`:

```json
{ "compilerOptions": { "typeRoots": ["node_modules/@types", "node_modules"] } }
```

- [ ] **Step 3: Commit**

```bash
cd ~/.pi
git add pi-vscode/src/extension.ts
git commit -m "feat(pi-vscode): add main extension entry point"
```

---

### Task B14: Build and install VS Code extension

- [ ] **Step 1: Compile**

```bash
cd ~/.pi/pi-vscode && npx tsc -p tsconfig.json
```

Expected: `out/` directory populates with compiled JS files.

- [ ] **Step 2: Install extension for testing**

```bash
cp -r ~/.pi/pi-vscode ~/.vscode/extensions/pi-vscode
```

Or use VS Code's built-in extension loader:
```bash
code --install-extension ~/.pi/pi-vscode/pi-vscode-0.1.0.vsix 2>/dev/null || echo "Install manually: copy to ~/.vscode/extensions/pi-vscode"
```

- [ ] **Step 3: Verify in VS Code**

1. Open VS Code
2. Press `Ctrl+Shift+P` → run `pi: Start`
3. Check "pi" sidebar appears in Activity Bar
4. Check status bar shows pi status

---

## Part C: Integration Verification

### Task C1: Full integration smoke test

- [ ] **Step 1: Start pi with pi-bridge**

In a VS Code terminal:
```bash
cd ~/.pi && pi
```

- [ ] **Step 2: Run `pi: Start`** from VS Code command palette. Verify:
  - New terminal opens named "pi"
  - Status bar shows "pi: disconnected" briefly, then "pi: <model> | ..."
  - Piper icon appears in Activity Bar

- [ ] **Step 3: Check Sessions tab**
  - Click pi icon in Activity Bar
  - Select "Sessions" tab
  - Verify session entries appear
  - Click a branch node → context menu shows "Fork Here" / "Resume"

- [ ] **Step 4: Test file change tracking**
  - In pi terminal: ask the agent to edit a file (e.g., "create a README.md")
  - Switch to "Files" tab
  - Verify the modified file appears with (M) or (A) status
  - Click file → diff editor opens

- [ ] **Step 5: Test Skills tab**
  - Switch to "Skills" tab
  - Verify skills appear with descriptions
  - Click a skill → SKILL.md opens in editor

- [ ] **Step 6: Test Stats tab**
  - Switch to "Stats" tab
  - Verify webview renders with model, tokens, turns

- [ ] **Step 7: Stop pi**
  - Click status bar → "Stop pi" → pi terminates
  - Status bar turns red/disconnected

- [ ] **Step 8: File cleanup**
  - Verify `~/.pi/agent/.pi-bridge-port` does not exist

- [ ] **Step 9: Commit** (if fixes were made during testing)

---

## Summary of All Files

| File | Task | Purpose |
|------|------|---------|
| `agent/extensions/pi-bridge/package.json` | A1 | Dependencies (ws) |
| `agent/extensions/pi-bridge/tsconfig.json` | A1 | TypeScript config |
| `agent/extensions/pi-bridge/src/protocol.ts` | A2 | WS message type definitions |
| `agent/extensions/pi-bridge/src/server.ts` | A3 | WebSocket server, port discovery |
| `agent/extensions/pi-bridge/src/commands.ts` | A4 | Proxy commands (fork, resume) |
| `agent/extensions/pi-bridge/src/index.ts` | A5 | Entry: events → WS push |
| `pi-vscode/package.json` | B1 | Extension manifest |
| `pi-vscode/tsconfig.json` | B1 | TypeScript config |
| `pi-vscode/.vscodeignore` | B1 | Package ignore |
| `pi-vscode/src/types.ts` | B2 | Protocol types (mirror) |
| `pi-vscode/src/bridge.ts` | B3 | WebSocket client |
| `pi-vscode/src/store.ts` | B4 | Reactive state store |
| `pi-vscode/src/terminal.ts` | B5 | Terminal manager |
| `pi-vscode/src/statusBar.ts` | B6 | Status bar item |
| `pi-vscode/src/commands.ts` | B7 | Command registrations |
| `pi-vscode/src/extension.ts` | B13 | Main entry point |
| `pi-vscode/src/sidebar/sessions.ts` | B8 | Sessions tree |
| `pi-vscode/src/sidebar/files.ts` | B9 | Files tree |
| `pi-vscode/src/sidebar/kb.ts` | B10 | KB tree |
| `pi-vscode/src/sidebar/skills.ts` | B11 | Skills tree |
| `pi-vscode/src/sidebar/stats.ts` | B12 | Stats webview |

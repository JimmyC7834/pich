# pi-vscode Enhancement — Design Spec

**Date:** 2026-06-13
**Status:** Approved

## Overview

Three enhancements to the pi VS Code extension + pi-bridge:

1. **Auto-connect** — VS Code discovers and connects to running pi sessions automatically (no manual `pi: Connect`)
2. **File diff in VS Code diff editor** — Clicking a changed file opens native side-by-side diff, not a plain text document
3. **Unified Capabilities tab** — Merges Skills + KB + Tools into one searchable, grouped webview panel

---

## Feature 1: Auto-Connect

### Protocol Changes

**`PiState` gets `cwd` field:**

```typescript
// protocol.ts (both pi-bridge and pi-vscode types.ts)
interface PiState {
  model?: string;
  thinkingLevel?: string;
  isStreaming: boolean;
  activeTools?: string[];
  tokensInput?: number;
  tokensOutput?: number;
  cost?: number;
  turns?: number;
  toolCalls?: number;
  cwd?: string;  // ← NEW
}
```

### pi-bridge (`index.ts`)

- `session_start` handler: capture `ctx.cwd`, include it in `state.cwd` before broadcasting
- `session_shutdown` handler: if reason is `"new" | "resume" | "fork"`, broadcast a shutdown error to VS Code clients so they know to start watching for a new port file (the next `session_start` will write a fresh one)

### pi-vscode (`extension.ts`, `bridge.ts`)

**Activation flow:**

```
activate():
  1. Register all views + commands (existing)
  2. checkPortAndAutoConnect():
     a. Read ~/.pi/agent/.pi-bridge-port
     b. If exists and pid alive: connect, receive state
     c. If state.cwd matches any workspace folder → stay connected silently
     d. If state.cwd doesn't match → disconnect (wrong project)
  3. startPortWatcher():
     a. fs.watch on ~/.pi/agent/ directory (fallback: 2s poll on Windows where fs.watch may be unreliable on directories)
     b. On .pi-bridge-port creation: if not already connected → auto-connect
     c. On .pi-bridge-port deletion (WS close): begin watching, status bar shows "pi: disconnected (retrying...)"
     d. On re-connection: status bar updates to normal connected state
```

**Status bar behavior:**
- Connected: existing behavior (`$(hubot) pi: model | tokens | cost`)
- Disconnected but watching: `$(sync~spin) pi: searching...`
- Never-connected (no port file ever existed): `$(circle-slash) pi: not running` (only if user manually invoked `pi: Start` or `pi: Connect`)
- Connection error: `$(error) pi: connection failed`

**Commands preserved:**
- `pi: Start` — still available for first launch
- `pi: Connect` — still available as manual fallback
- `pi: Refresh` — still available to force reconnect

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Multiple pi instances on same machine (different workspaces) | VS Code checks `cwd` match; only connects to matching workspace |
| pi restarts with `/new` | Old WS closes → `session_shutdown` → new `session_start` writes fresh port file → watcher picks it up → auto-reconnect |
| VS Code opens with no pi running | Port file absent → watcher waits → status bar shows "searching..." → user can `pi: Start` manually |
| pi crashes (no clean shutdown) | pid check in `readPortFile()` fails → watcher removes stale port → starts polling for new one |
| User opens VS Code in a non-pi project | Port file has different cwd → auto-connect skips → status bar hidden |

---

## Feature 2: File Diff in VS Code Diff Editor

### Protocol Changes

**Extend `diff` command response:**

```typescript
// In protocol.ts PiToVSCode union:
| { type: "response"; id: string; data: { diff: string; original: string; modified: string } }
```

### pi-bridge (`index.ts`)

**`diff` command handler:**

```
case "diff":
  1. original = exec("git show HEAD:" + path) — empty string if file is new/untracked
  2. modified = readFile(path) — current working tree content
  3. diff = exec("git diff " + path) — the unified diff (for fallback)
  4. reply({ type: "response", data: { diff, original, modified } })
```

Error handling:
- If `git show HEAD:<path>` fails (file not in git): `original = ""`
- If readFile fails (file deleted): `modified = ""`, status = "D"
- If `git diff` fails (not a git repo): still return original/modified so diff editor works

### pi-vscode (`commands.ts`)

**`pi.showDiff` handler rewrite:**

```typescript
cmd("pi.showDiff", async (file) => {
  const f = file as { path?: string; status?: string } | undefined;
  if (!f?.path) return;

  try {
    const result = await bridge.send({ type: "diff", path: f.path }) as
      { diff?: string; original?: string; modified?: string };

    const originalUri = vscode.Uri.parse(`untitled:${path.basename(f.path)}.original`)
      .with({ scheme: "untitled", path: `${path.basename(f.path)}.original` });
    const modifiedUri = vscode.Uri.parse(`untitled:${path.basename(f.path)}.modified`)
      .with({ scheme: "untitled", path: `${path.basename(f.path)}.modified` });

    // Create untitled docs with content
    const originalDoc = await vscode.workspace.openTextDocument({ content: result.original ?? "", language: detectLanguage(f.path) });
    await originalDoc.save(); // forces the document to exist for the diff editor
    // Actually use a better approach: use vscode.Uri with the actual file path for modified
    const originalContent = result.original ?? "";
    const modifiedContent = result.modified ?? "";

    // Best approach: create temp files or use workspace.openTextDocument with custom content
    // Use the file's own URI for "modified" (right side) and a virtual doc for "original" (left side)

    // Open the actual file (right side)
    const fileUri = vscode.Uri.file(f.path);

    // Create a virtual document for the original (left side)
    const originalFileUri = vscode.Uri.parse(`untitled:${f.path.replace(/[/\\:]/g, "_")}~HEAD`)
      .with({ scheme: "untitled" });

    const origDoc = await vscode.workspace.openTextDocument(originalFileUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(originalFileUri, new vscode.Position(0, 0), originalContent);
    await vscode.workspace.applyEdit(edit);

    await vscode.commands.executeCommand("vscode.diff", originalFileUri, fileUri, `${path.basename(f.path)}: HEAD → Working Tree`);
  } catch {
    // Fallback: just open the file
    try { await vscode.window.showTextDocument(vscode.Uri.file(f.path)); } catch {}
  }
});
```

**Key decisions:**
- Left side (original): virtual untitled document with `git show HEAD:<path>` content
- Right side (modified): the actual file on disk at `path`
- Title: `<filename>: HEAD → Working Tree`
- If file is deleted (status "D"): show original content on left, empty on right
- If file is new (no HEAD version): show empty on left, file content on right
- Language detection: from file extension for syntax highlighting

**Fallback for non-git projects:**
- If `original` is empty and `modified` has content (new file): open file directly
- If both empty: show error toast

---

## Feature 3: Unified Capabilities Tab

### New View: `pi-capabilities`

Replaces `pi-skills` and `pi-kb` views. Uses `WebviewViewProvider` (same pattern as Stats panel).

### Protocol Changes

**New `capabilities` event type:**

```typescript
// protocol.ts (PiToVSCode union)
| { type: "capabilities"; data: CapabilitiesSnapshot }

interface CapabilitiesSnapshot {
  loadoutName?: string;
  activeTools: string[];  // tool names currently active
  activeSkills: string[]; // skill names currently loaded (in loadout)
  tools: ToolEntry[];     // ALL available tools
  skills: SkillEntry[];   // ALL available skills (disk scan)
  kBCollections: KBDocCollection[];  // KB collections with doc details
}

interface ToolEntry {
  name: string;
  description: string;
  schema?: unknown;       // parameter schema (JSON)
  source: string;         // "builtin" | "extension" | etc.
  sourcePath: string;     // file path
  isActive: boolean;      // true if in activeTools
}

interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  tags?: string[];        // from SKILL.md frontmatter
  category?: string;      // derived from tags or directory
  isActive: boolean;      // true if in the current loadout
}

interface KBDocCollection {
  name: string;
  docs: KBDocEntry[];
}

interface KBDocEntry {
  id: string;             // doc filename without .md
  title: string;          // from frontmatter title or filename
  filePath: string;       // full path to .md file
  tags?: string[];        // from frontmatter
}
```

### pi-bridge (`index.ts`)

**New function: `buildCapabilities()`**

Called on `session_start` and via explicit refresh command.

```
buildCapabilities():
  1. ALL TOOLS:
     - tools = pi.getAllTools()  → ToolInfo[]
     - map to ToolEntry[], set isActive from pi.getActiveTools()
  2. ALL SKILLS:
     - Scan ~/.pi/skills/ recursively for SKILL.md files
     - Parse frontmatter: name, description, tags
     - For each, check if name is in loaded skills (pi.getCommands() filtered by source==="skill")
     - Set isActive if in loaded skills
  3. KB COLLECTIONS:
     - Scan ~/.pi/kb/ for subdirectories
     - For each .md file: parse frontmatter for title, tags
     - Build KBDocCollection[] with individual doc entries
  4. Broadcast { type: "capabilities", data: snapshot }
```

**KB doc content:**
- `kb_open` handler: read file from `~/.pi/kb/<collection>/<docId>.md`, return content
- `kb_search` handler: use `grep -rl` across KB files for the query, return matching doc IDs and snippet lines

**Skill content:**
- `skill_inspect` handler: read SKILL.md file at given path, return full markdown content
- (Already handled by pi-vscode opening the file directly, but returning content enables the webview detail panel later)

**`allSkills` scan details:**
- Walk `~/.pi/skills/` (or `~/.pi/agent/skills/`? — use the same locations pi discovers skills from)
- For each `SKILL.md`: parse YAML frontmatter between `---` delimiters
- Extract: `name`, `description`, `tags` (array of strings)
- Category derivation: from first tag, or directory name, or "uncategorized"

### pi-vscode

#### `store.ts`

- Add `capabilities: CapabilitiesSnapshot | null` field
- Add `setCapabilities(snapshot)` method
- Emit `"changed"` on set

#### `bridge.ts`

- Add `"capabilities"` event to `PiBridgeEvents`:
  ```typescript
  capabilities: [data: CapabilitiesSnapshot];
  ```
- Wire in `handleMessage`: `case "capabilities": this.emit("capabilities", msg.data);`

#### `extension.ts`

- Remove SkillsProvider and KBProvider registrations
- Add CapabilitiesProvider registration:
  ```typescript
  vscode.window.registerWebviewViewProvider("pi-capabilities", new CapabilitiesProvider(store, bridge));
  ```
- Wire capabilities event to store:
  ```typescript
  bridge.on("capabilities", (data) => store.setCapabilities(data));
  ```
- Add `pi.refreshCapabilities` command (called from webview refresh button)

#### `sidebar/capabilities.ts` (NEW — WebviewViewProvider)

**Webview layout:**

```
┌──────────────────────────────────────────┐
│ [🔍 Filter capabilities...        ]  [🔄]│  ← search + refresh
├──────────────────────────────────────────┤
│ ▼ ACTIVATED (5)                          │  ← collapsible, default open
│                                          │
│   🛠️ Tools (3)                           │  ← sub-section header
│     ✅ read      Read file contents       │  ← green dot + name + desc
│     ✅ write     Write/create files       │
│     ✅ bash      Execute shell commands   │
│                                          │
│   🧠 Skills (2)                          │
│     ✅ brainstorming   Design before code │
│     ✅ executing-plans Implementation     │
│                                          │
├──────────────────────────────────────────┤
│ ▼ ALL (47)                               │  ← collapsible, default collapsed
│                                          │
│   ▼ 🛠️ Tools (15)                        │  ← collapsed by default
│                                          │
│   ▼ 🧠 Skills (20)                       │
│       brainstorming   ✅ active           │  ← badge shows active status
│       caveman         Ultra-compressed    │
│       csv-export       Export to CSV      │
│       ...                                │
│                                          │
│   ▼ 📚 Knowledge Library (12)            │
│     ▼ pi-docs (3 docs)                   │  ← collection → expand to docs
│       pi-extensions     Extension guide   │
│       pi-sdk            SDK reference     │
│       ...                                │
│     ▶ typescript (2 docs)                │
│     ▶ react-patterns (1 doc)             │
└──────────────────────────────────────────┘
```

**Click behavior:**

| Item type | Click action |
|-----------|-------------|
| Skill (any) | Open SKILL.md via `vscode.window.showTextDocument` |
| Tool (any) | Open tool definition JSON in a new editor tab, or show detail in the webview |
| KB doc | Send `kb_open` via bridge → receive content → open as markdown document in editor |
| KB collection | Toggle expand/collapse in webview (show docs) |
| Section header | Toggle expand/collapse in webview |

**Refresh:**
- 🔄 button sends `{ type: "refresh_capabilities" }` via bridge
- pi-bridge handles this by calling `buildCapabilities()` and broadcasting the `capabilities` event

**Search behavior:**
- Type in filter bar → debounced (150ms) → hide items whose name/description/tags don't match
- Match is case-insensitive substring
- Sections without any matching children are hidden
- "ACTIVATED" and "ALL" headers remain visible always

**Refresh:**
- 🔄 button sends `{ type: "command", command: "/capability-refresh" }` or triggers a capabilities re-scan via bridge
- Actually: simpler to add a `refresh_capabilities` message type that pi-bridge handles by calling `buildCapabilities()` and broadcasting

#### `commands.ts`

**Updated click handlers:**

```typescript
// Open KB doc (proper implementation)
cmd("pi.openKBDoc", async (doc) => {
  const d = doc as { docId?: string; collection?: string } | undefined;
  if (!d?.docId) return;
  const result = await bridge.send({ type: "kb_open", docId: d.docId, collection: d.collection });
  const content = (result as { content?: string })?.content;
  if (content) {
    const td = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(td);
  }
});

// Inspect tool definition
cmd("pi.inspectTool", async (tool) => {
  const t = tool as { name?: string; schema?: unknown } | undefined;
  if (!t?.name) return;
  const json = JSON.stringify(t.schema ?? { name: t.name }, null, 2);
  const doc = await vscode.workspace.openTextDocument({ content: json, language: "json" });
  await vscode.window.showTextDocument(doc);
});
```

#### `package.json`

```json
"views": {
  "pi-sidebar": [
    { "id": "pi-sessions", "name": "Sessions", "icon": "$(git-branch)" },
    { "id": "pi-files", "name": "Files", "icon": "$(diff)" },
    { "id": "pi-capabilities", "name": "Capabilities", "icon": "$(symbol-namespace)" },
    { "id": "pi-stats", "name": "Stats", "icon": "$(pulse)" }
  ]
},
"commands": [
  // ... existing commands ...
  { "command": "pi.inspectTool", "title": "pi: Inspect Tool" },
  { "command": "pi.refreshCapabilities", "title": "pi: Refresh Capabilities" }
]
```

Remove: `pi-kb`, `pi-skills` views.

---

## File Manifest

### pi-bridge (server side)

| File | Action | Notes |
|------|--------|-------|
| `protocol.ts` | Edit | Add cwd to PiState, add CapabilitiesSnapshot types, add capability event types |
| `index.ts` | Edit | Capture cwd, buildCapabilities(), implement kb_open/kb_search, skill scan from disk |
| `server.ts` | No change | — |
| `commands.ts` | No change | — |

### pi-vscode (client side)

| File | Action | Notes |
|------|--------|-------|
| `src/types.ts` | Edit | Add CapabilitiesSnapshot, ToolEntry, SkillEntry, KBDocEntry, KBDocCollection; add cwd to PiState |
| `src/bridge.ts` | Edit | Add capabilities event, port file watcher, auto-connect support |
| `src/store.ts` | Edit | Add capabilities state, setCapabilities(), cwd state |
| `src/extension.ts` | Edit | Auto-connect flow, port watcher, register CapabilitiesProvider, remove Skills+KB providers |
| `src/terminal.ts` | No change | — |
| `src/statusBar.ts` | Edit | Add retrying/watching states |
| `src/commands.ts` | Edit | Rewrite showDiff for vscode.diff, add inspectTool, fix openKBDoc |
| `src/sidebar/sessions.ts` | No change | — |
| `src/sidebar/files.ts` | No change | — (click handler fixed in commands.ts) |
| `src/sidebar/capabilities.ts` | **NEW** | WebviewViewProvider with full capabilities UI |
| `src/sidebar/kb.ts` | **DELETE** | Merged into capabilities |
| `src/sidebar/skills.ts` | **DELETE** | Merged into capabilities |
| `src/sidebar/stats.ts` | No change | — |
| `package.json` | Edit | Replace pi-skills + pi-kb views with pi-capabilities, add commands |

### Bugfix: Relative Path Resolution

The existing file tracking passes paths from pi tool calls (which may be relative) to VS Code. With `cwd` now in state:
- `commands.ts` `pi.showDiff`: resolve relative paths against `store.state.cwd` (workspace root)
- `bridge.ts` `fileChanged` handler: optionally resolve paths on receipt (defer to command handler)

---

## Testing Plan

### Auto-Connect
1. Start pi in a workspace → reload VS Code → verify auto-connect within 2s, no manual action
2. Run `/new` in pi → verify VS Code disconnects, then reconnects to the new session
3. Start pi in a different workspace → verify the original VS Code does NOT connect (cwd mismatch)
4. Kill pi process → verify VS Code status bar shows "searching...", then reconnects when pi restarts
5. Open VS Code with no pi running → verify status bar shows "not running" after brief search

### File Diff
1. Edit a file, let pi-bridge push `file_changed` → click the file in Files panel → verify side-by-side diff editor opens
2. Create a new file (status "A") → click → verify diff shows empty left, new content right
3. Delete a file (status "D") → click → verify diff shows original left, empty right
4. Non-git project → verify graceful fallback (opens file directly)

### Capabilities Tab
1. Verify activated skills/tools appear in "ACTIVATED" section
2. Verify all skills appear in "ALL" with correct active badges
3. Verify KB collections show with individual doc entries
4. Type in search bar → verify real-time filtering
5. Click a skill → verify SKILL.md opens
6. Click a KB doc → verify doc content opens in editor
7. Click a tool → verify tool definition JSON opens
8. Click refresh → verify capabilities re-scan

---

## Out of Scope (Future)

- Session tree nesting (parent/child hierarchy — current data is already available, just needs TreeDataProvider changes)
- Reconnect on pi restart is handled by auto-connect (replaces the manual `pi: Refresh` need)
- KB search from within VS Code (protocol exists, UI not in this iteration)
- Capabilities detail panel (inline tool/skill descriptions in webview vs opening external editor)
- Loadout management from VS Code (switching loadouts, editing loadout composition)
- Tool enable/disable from VS Code sidebar

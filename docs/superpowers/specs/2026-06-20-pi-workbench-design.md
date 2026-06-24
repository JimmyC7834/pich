# pi Workbench — Design (DRAFT / brainstorming in progress)

> **Status:** Brainstorming handoff. Sections 1 locked-pending-approval; Sections 2–3 (data flow & persistence, error handling & testing) NOT yet drafted. This is a **resume point**, not a finished spec. A picking-up agent should continue the `superpowers:brainstorming` flow from "Section 2" below, get per-section approval, then write the full spec and invoke `superpowers:writing-plans`.
>
> **Date:** 2026-06-20 · **Owner discussion:** jc4649 · **Topic:** unified Tauri workbench that hosts pi agents + an editor.

---

## 1. Goal

A **lightweight, bespoke desktop workbench** where the pi agent and a code editor **co-exist** in one window. The "AI surface" is **pi running as a CLI inside embedded terminal panes** (multiple, parallel) — explicitly **not** a custom AI-chat panel. The user wants a unified environment with custom UI/UX around their pi extensions and settings, but for v1 the extension UIs are reused as-is by running pi-tui inside terminals.

**Why this shape:** The user already runs pi in a terminal daily. The value of the workbench is the *combination* — editor + file tree + many parallel pi agents + saved workspace — in one lightweight app they own, not an IDE that merely embeds a chat box. ACP (Agent Client Protocol) was considered and rejected as the primary model because ACP assumes the editor hosts the agent as a subprocess behind a fixed chat UI; the user wants custom UX and terminal-hosted agents instead. ACP may return later as one optional wire, not the architecture.

## 2. Context: what pi is (for an agent with no prior context)

- pi lives at `C:\Users\c7834\.pi`. It's a TypeScript agent harness; extensions run via **jiti** (no build step).
- Extensions auto-load from `~/.pi/agent/extensions/` — either a folder with `package.json` declaring `pi.extensions`, or bare `.ts` files.
- Several extensions render terminal UIs via **pi-tui** (`@earendil-works/pi-tui`): `capability-browser.ts` (interactive browsable overlay), `pi-web-tools` (a `Ctrl+Shift+W` panel), plus lighter text rendering in `startup-logo.ts`, `pi-hashline-edit`. These are the "extension UIs" that v1 will surface by running pi inside a terminal.
- pi is invoked as the `pi` CLI (PowerShell is the user's shell on Windows 10).

## 3. Locked decisions (from brainstorming Q&A)

| # | Decision | Choice |
|---|----------|--------|
| Shell direction | How the unified env is built | **Tauri + Monaco (bespoke)** — own all UI/UX, pi as backend process. (Over Theia / VSCode-extension.) |
| Agent surface | chat panel vs terminals | **Embedded terminals running pi directly**, multiple in parallel. No custom chat panel. |
| Extension UI | how pi extensions appear | **Embed a terminal, reuse pi-tui as-is.** No GUI-view RPC bridge in v1. |
| MVP scope | minimum v1 | **Full workspace** = file tree + editor + multi-terminal + **session persistence** (save/restore folder, layout, terminal dirs). |
| Layout | pane arrangement | **Hybrid** — fixed file-tree sidebar + **tiling main area** (editor & terminals are first-class tileable panes). |
| Settings/extensions UI | custom GUI vs files/terminal | **Read-only extensions panel** — lists installed pi extensions (name, status, description) from disk, click → opens config/source in Monaco. No toggles/forms in v1. |
| Terminal model | how pi-aware | **pi-aware launcher + generic shells** — "New pi agent" spawns pi in a chosen dir (labeled by dir); also plain shells. Restore **re-launches** pi agents in their dirs. |
| Editor depth | LSP or not | **Quick view/edit, no LSP** — syntax highlight, multi-tab, find/replace, save. pi does real code work in terminals. |
| Platform | targets | **Windows-only v1.** ConPTY via portable-pty, PowerShell default shell. Cross-platform deferred. |
| Frontend approach | layout/state stack | **Approach B — hand-rolled splits.** Thin resize lib only; layout tree + tabs + serialization are hand-built. (Over dockview / Electron.) |

### Settled backend primitives (not in dispute)
- **Tauri v2** desktop app.
- **`portable-pty`** (wezterm crate) for PTYs → drives **ConPTY** on Windows. One PTY per terminal pane.
- PTY output streams Rust→JS over **Tauri v2 Channels**; spawn/input/resize/kill are Tauri **commands**.
- Frontend: **React + TypeScript + Vite**. **xterm.js** terminals, **Monaco** editor. `react-resizable-panels` (or `allotment`) for resize handles **only** — everything else hand-built.

## 4. Section 1 — Architecture & components (PROPOSED, pending user approval)

**Rust backend (`src-tauri/`), one file per responsibility:**
- `pty.rs` — PTY manager. `HashMap<SessionId, PtyHandle>`; each handle owns the ConPTY child, a writer, and a reader thread streaming output bytes to the frontend over a **per-session Tauri Channel**. Commands: `pty_spawn(kind, cwd) -> SessionId`, `pty_write(id, data)`, `pty_resize(id, cols, rows)`, `pty_kill(id)`. `kind` ∈ {`pi`, `shell`}.
- `fs.rs` — directory-tree listing + file read/write; open-folder via Tauri dialog plugin.
- `extensions.rs` — scans `~/.pi/agent/extensions/`, returns `{name, status, description, path}` per extension. (Name/description from `package.json`'s `pi.extensions` or a bare `.ts` top-of-file comment; **status derivation is an open question — see §6**.)
- `workspace.rs` — persisted workspace model + `save`/`load` (JSON in Tauri app-data dir).
- `commands.rs` / `main.rs` — command registration + setup.

**Frontend (`src/`):**
- `layout/` — recursive **pane tree** (split nodes: direction + sizes + children; leaf panes = `editor-group` | `terminal`), a **pure reducer** (`split`, `close`, `resize`, `focus`), and `serialize`/`deserialize`.
- `panes/Terminal.tsx` — xterm.js bound to one PTY session via its Channel (onData → `pty_write`; resize → `pty_resize`; unmount → `pty_kill`).
- `panes/EditorGroup.tsx` — tabbed Monaco.
- `sidebar/FileTree.tsx` + `sidebar/Extensions.tsx` — the fixed sidebar's two sections.
- `ipc/` — typed wrappers over Tauri `invoke`/Channel. `state/store.ts` — holds layout tree + sessions + open editors. `App.tsx`.

**Scope call proposed (pending approval):** v1 layout supports **split / resize / close / tabs only — NO drag-to-rearrange** (hand-rolling drag-rearrange is expensive; defer to v1.1).

## 5. Remaining design sections to cover (NOT yet drafted — resume here)

The brainstorming was interrupted right after presenting Section 1. A resuming agent should draft and get approval on:

- **Section 2 — Data flow & persistence.** Expected content:
  - Terminal lifecycle: mount xterm → `pty_spawn(kind, cwd)` → subscribe Channel → pipe bytes; input/resize/kill paths.
  - Editor flow: click file in tree → `read_file` → open Monaco tab; Ctrl+S → `write_file`.
  - Persistence: on layout/session change (debounced) → serialize workspace {folder, layout tree, sessions:[{kind, cwd, title}], open editor tabs} → `save_workspace`; on startup → `load_workspace` → rebuild tree → **re-spawn pi/shell sessions in their cwds** → re-open editor tabs.
  - Open sub-decisions: single auto-restored "last workspace" vs multiple named workspaces (lean single for v1); where the workspace file lives (app-data dir keyed by folder, vs a `.pi/workspace.json` in the opened folder).
- **Section 3 — Error handling & testing.** Expected content:
  - Errors: PTY spawn failure / `pi` not found → error state in the pane with retry; process exit → mark terminal "exited" + restart affordance; file read/write errors → toast; corrupt workspace JSON → fall back to empty workspace.
  - Testing: Rust unit tests for PTY manager (spawn echo, write/read roundtrip, resize, kill), extensions scanner, workspace serialize/restore roundtrip. Frontend: layout-tree reducer unit tests (split/close/resize/serialize roundtrip), component wiring tests for Terminal/EditorGroup with mocked Tauri IPC.

## 6. Open questions to resolve before/while drafting Sections 2–3

1. **Extension "status" semantics.** What does on/off mean for a read-only panel? Candidates: "present in live `extensions/` dir" = on vs `_archived-extensions/` = off; or a disable flag/env (e.g. `PI_SEMBLE_DISABLE`). Needs a quick look at how pi currently enables/disables extensions before the scanner can report status truthfully.
2. **Workspace persistence location & multiplicity** (see Section 2 sub-decisions).
3. **Confirm the "no drag-rearrange in v1" scope call** with the user (proposed in Section 1).
4. **pi launch command details** — exact invocation for a "New pi agent" in a given cwd (just `pi`? any flags? working-dir semantics).

## 7. Known technical risks (Windows-specific)

- **ConPTY quirks** via portable-pty (resize timing, output flushing).
- **Glyph/Nerd-font rendering** in xterm.js so pi-tui box-drawing/overlays look right.
- **Keyboard focus routing** — xterm.js captures keys that app-level shortcuts also want; need a clear focus/keymap policy.
- **Monaco + Vite bundling** (workers) under Tauri's webview.

## 8. How to resume (for the picking-up agent)

1. Read this doc top to bottom; the conversation it came from is not needed.
2. Re-enter `superpowers:brainstorming` at the "present design sections" step. Get user approval on Section 1's scope call (no drag-rearrange), then draft + approve **Section 2** and **Section 3** above, resolving the §6 open questions as you go (ask the user one at a time; some need a peek at the pi repo).
3. Write the finalized spec to `docs/superpowers/specs/2026-06-20-pi-workbench-design.md` (replace this draft), run the spec self-review, get user sign-off.
4. Invoke `superpowers:writing-plans` to produce the implementation plan. Do not invoke any other implementation skill.

**Process note:** A `HARD-GATE` from brainstorming applies — no code/scaffolding until the user approves the completed design.

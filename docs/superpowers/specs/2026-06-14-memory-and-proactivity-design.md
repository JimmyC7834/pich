# Memory & Proactivity Enhancements — Design Spec

**Status:** Approved for implementation (2026-06-14)
**Scope:** Three small enhancements to the custom PI harness. One new dependency-free flat extension (`agent/extensions/memory.ts`) plus two targeted edits to existing siblings (`pi-capability-index`, `pi-research-library`).
**Goal:** (1) Give the agent an always-on 1-liner **memory** injected into the loadout; (2) make the agent **use skills proactively**; (3) make the agent **use the KB proactively** and give the user a manual way to **attach a doc** into a message.

---

## 1. Background & motivation

The harness already injects two "policy" blocks into the system prompt each turn via `before_agent_start`:

- `pi-capability-index` → `capPolicy` (tells the agent to `capability_search` for skills/tools it doesn't see).
- `pi-research-library` → `kbPolicy` (tells the agent to `kb_search`/`kb_cite` before answering from memory).

Both already say the right thing but are **too soft and buried**, so the agent under-uses skills and the KB. The `kbPolicy` even already references a **memory** concept (*"Personal preferences/lessons → memory, not the KB"*) and an earlier spec names a planned-but-unbuilt `pi-hermes-memory` sibling. This work fills that gap with the **minimum** code: a memory injector, and stronger wording in the two existing policies, plus one new command for manual doc attach.

### 1.1 Design principles (inherited from siblings)

- **Fail-open.** Any error in a hook injects nothing and never corrupts a request (mirrors `pi-context-manager`).
- **Loadout injection via `before_agent_start`**, appending to (never replacing) `event.systemPrompt`.
- **Memory ≠ KB.** Memory is tiny, always-on, never searched. It lives **outside** the `kb/` SQLite index so the RAG indexer never treats it as a searchable doc.
- **Minimal surface.** One new flat file (like `notify.ts` / `startup-logo.ts`, no `node_modules`), two one-paragraph policy edits, one new command.

---

## 2. Enhancement 1 — Memory (NEW `agent/extensions/memory.ts`)

A single dependency-free flat extension.

### 2.1 Store

- File: `agent/memory.md` (i.e. `~/.pi/agent/memory.md`). Plain text, one memory per line. Hand-editable; the file is the single source of truth.
- Blank lines and lines beginning with `#` are ignored (allows headings/spacers for the human).
- Outside the kb index — never indexed, never searched.

### 2.2 Injection (`before_agent_start`)

- Read `memory.md`; collect non-empty, non-`#` lines.
- Append to the system prompt as:
  ```
  <memory>
  Durable facts you (the agent) have saved. Treat as background; verify before relying on anything that may be stale.
  - <line 1>
  - <line 2>
  </memory>
  ```
- **Budget (~500 tokens ≈ ~2000 chars).** If the joined lines exceed the budget, keep the **last** lines (FIFO — newest win) that fit, and prepend a `- …(older memories trimmed)` marker. Newest-last ordering in the file means the tail is the freshest.
- Fail-open: missing file or any error → inject nothing.
- Kill switch: `MEMORY_DISABLE` env var → register nothing.
- Budget override: `MEMORY_BUDGET_CHARS` env var (default 2000).

### 2.3 Agent-writable `remember` tool

- Registered via `pi.registerTool`. Signature: `remember(text: string)`.
- Enforces the **1-liner rule**: collapse all whitespace/newlines to single spaces, trim, cap length (default 120 chars, truncate with `…`).
- Dedupe: if a normalized line already exists (case-insensitive), no-op and report "already remembered".
- Appends the line to `memory.md` (creating the file if absent). Returns a short confirmation.

### 2.4 User-writable command `/remember <text>`

- `pi.registerCommand("remember", …)`. Same normalization/dedupe as the tool; appends to `memory.md`.
- With no args, notify the user of the file path and current memory count.
- `/forget` is **out of scope** (YAGNI) — the user prunes by hand-editing `memory.md`.

---

## 3. Enhancement 2 — Skills proactivity (EDIT `pi-capability-index/src/policy.ts`)

- No logic change. The existing `before_agent_start` already injects `capPolicy`.
- Strengthen the **compact** `capPolicy` string with an explicit imperative trigger so the agent reaches for skills before improvising. Target wording (final phrasing tuned in implementation, kept compact):
  > "Before acting on any non-trivial task, first consider whether a skill applies. Only your active loadout's skills are shown; many more exist unlisted. If none shown fits, run `capability_search` BEFORE improvising — do not wing a task a skill exists for. Then `capability_activate(id)` to load it."
- Keep it inside the existing `<capability-policy>` tags and under a couple of sentences; the `full` style keeps its existing promotion note.

---

## 4. Enhancement 3 — Doc referencing (EDIT `pi-research-library`)

Two parts.

### 4.1 Stronger KB proactivity (`src/policy.ts`)

- Strengthen the **compact** `kbPolicy` string with a parallel imperative: search/cite the KB **before** answering substantive library/API/domain questions from memory, rather than treating it as optional. Keep inside `<kb-policy>` tags, stay compact, preserve the existing memory/`kb_write`/low-confidence guidance.

### 4.2 New `/ref <query>` command

- Registered in `pi-research-library` (reuses the existing `kb_search` index — that's why it lives here, not in `memory.ts`).
- Runs `kb_search` for `<query>`, takes the **top-1** hit, and injects that doc's text into context as an attached reference for the user's current message. This is the user's manual "attach a doc into my message" path.
- Empty query or no hit → notify the user (no injection).
- Injects top-1 only to keep context lean; the user re-runs with a sharper query on a miss. (Top-K deferred.)
- Mechanism: follow the same context-injection pattern the existing research-library commands use (confirm the exact API — command result vs. context message — against the sibling commands during implementation).

---

## 5. Out of scope / deferred

- `/forget` command and memory editing UI — hand-edit `memory.md`.
- Collections/priority for memory budget — FIFO is enough; revisit if memory grows.
- Auto-extraction of memories at session end — explicit `remember` only, to avoid noise.
- `/ref` top-K and fuzzy disambiguation UI.
- Promoting memory into its own package (`pi-hermes-memory`) — start as a flat file; graduate only if it grows deps.

---

## 6. Acceptance criteria

1. `agent/extensions/memory.ts` loads with no `node_modules`; with `MEMORY_DISABLE` set it registers nothing.
2. Adding a line to `agent/memory.md` (by hand, by `/remember`, or by the `remember` tool) causes that line to appear in the next turn's system prompt inside a `<memory>` block.
3. `remember` normalizes multi-line / overlong input to a single capped line and dedupes.
4. Memory over budget keeps the newest lines and shows the trimmed marker; the hook never throws (fail-open).
5. `capPolicy` and `kbPolicy` compact strings contain the strengthened imperative wording.
6. `/ref <query>` injects the top KB hit's text into context; empty/no-hit notifies without injecting.

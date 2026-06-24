# Ralph Kanban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi extension (`pi-ralph`) that runs a Ralph loop over a SQLite-backed kanban backlog — the AI works tasks one at a time, context compacted after each, until the board is empty.

**Architecture:** In-session loop. A `RunState` flag (set by `/ralph-run`) makes `before_agent_start` re-inject the protocol + live board every turn (survives compaction). `ralph_complete` flags `pendingContinue`; the `turn_end` driver then compacts and injects a continuation turn, or stops on empty board / max-iterations / `--once`. Storage is SQLite via `better-sqlite3`. Done-gate is soft (the AI self-reports; correctness leans on its own `verify` run + CI).

**Tech Stack:** TypeScript (ESM, NodeNext), `better-sqlite3`, `typebox`, `vitest`. Modeled on the sibling `pi-capability-index` extension.

Spec: `docs/superpowers/specs/2026-06-19-ralph-kanban.md`.

## Global Constraints

- Extension dir: `agent/extensions/pi-ralph/`. Entry: `./index.ts` (via `package.json` `pi.extensions`).
- ESM + NodeNext: **all intra-package imports use the `.js` extension** (e.g. `import { x } from "./store.js"`) even though sources are `.ts`.
- `import { Type } from "typebox";` (NOT `@sinclair/typebox`) — matches this repo.
- Dependency floors (copy verbatim): `better-sqlite3@^11.8.0`, `typebox@^1.1.24`; dev: `vitest@^2.1.0`, `typescript@^5.6.0`, `@types/better-sqlite3@^7.6.11`, `@types/node@^20.0.0`, `@earendil-works/pi-coding-agent@^0.74.2`.
- Tool execute return shape: `{ content: [{ type: "text", text }], details: {} }`.
- Every pi hook (`before_agent_start`, `turn_end`) must **fail open** — a `try/catch` that returns/does nothing on error; never throw out of a hook.
- DB path: `process.env["RALPH_DB"] ?? <cwd>/.pi/ralph/ralph.db`. `<root>/.pi/` is already gitignored. Tests set `RALPH_DB=:memory:`.
- `tsconfig.json`: `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `strict`, `esModuleInterop`, `skipLibCheck`, `noEmit`, `types:["node"]`; `include ["index.ts","src/**/*.ts"]`, `exclude ["test/**/*.ts","node_modules"]`.
- `created_by` = `"ai"` for tool-created tasks, `"human"` for command-created.
- Run all tests with `pnpm test` (or `npx vitest run`) from `agent/extensions/pi-ralph/`.

---

### Task 1: Scaffold extension + open the database

**Files:**
- Create: `agent/extensions/pi-ralph/package.json`
- Create: `agent/extensions/pi-ralph/tsconfig.json`
- Create: `agent/extensions/pi-ralph/src/schema.ts`
- Create: `agent/extensions/pi-ralph/src/db.ts`
- Test: `agent/extensions/pi-ralph/test/db.test.ts`

**Interfaces:**
- Produces: `DDL: string` (schema.ts); `type DB = Database.Database`, `openRalphDb(file: string): DB` (db.ts).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pi-ralph",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "vitest run", "check": "tsc --noEmit" },
  "dependencies": {
    "better-sqlite3": "^11.8.0",
    "typebox": "^1.1.24"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.2",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "allowScripts": { "better-sqlite3@11.10.0": true }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "noEmit": true, "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts"],
  "exclude": ["test/**/*.ts", "node_modules"]
}
```

- [ ] **Step 3: Install deps**

Run (from `agent/extensions/pi-ralph/`): `pnpm install`
Expected: `better-sqlite3` builds its native binding. If pnpm prompts about build scripts, approve `better-sqlite3` (the `allowScripts` entry handles this). Verify: `node -e "require('better-sqlite3')"` exits 0.

- [ ] **Step 4: Create `src/schema.ts`**

```ts
export const DDL = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
  active_run INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  spec TEXT NOT NULL, prd TEXT, priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo', depends_on TEXT NOT NULL DEFAULT '[]',
  verify TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, done_at TEXT);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
CREATE TABLE IF NOT EXISTS progress(
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT,
  ts TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_progress_project ON progress(project_id, id);
`;
```

- [ ] **Step 5: Write the failing test `test/db.test.ts`**

```ts
import { test, expect } from "vitest";
import { openRalphDb } from "../src/db.js";

test("openRalphDb applies the schema (projects/tasks/progress exist)", () => {
  const db = openRalphDb(":memory:");
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map((r: any) => r.name);
  expect(names).toContain("projects");
  expect(names).toContain("tasks");
  expect(names).toContain("progress");
});
```

- [ ] **Step 6: Run the test, verify it FAILS**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — `Cannot find module '../src/db.js'`.

- [ ] **Step 7: Create `src/db.ts`**

```ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DDL } from "./schema.js";

export type DB = Database.Database;

export function openRalphDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
  return db;
}
```

- [ ] **Step 8: Run the test, verify it PASSES**

Run: `npx vitest run test/db.test.ts`
Expected: PASS (1 test).

- [ ] **Step 9: Commit**

```bash
git add agent/extensions/pi-ralph/package.json agent/extensions/pi-ralph/tsconfig.json \
        agent/extensions/pi-ralph/src/schema.ts agent/extensions/pi-ralph/src/db.ts \
        agent/extensions/pi-ralph/test/db.test.ts
git commit -m "feat(ralph): scaffold pi-ralph extension + sqlite schema"
```

---

### Task 2: Task/project store — create, list

**Files:**
- Create: `agent/extensions/pi-ralph/src/types.ts`
- Create: `agent/extensions/pi-ralph/src/store.ts`
- Test: `agent/extensions/pi-ralph/test/store.test.ts`

**Interfaces:**
- Consumes: `openRalphDb`, `DB` from `./db.js`.
- Produces (types.ts): `type Status = "todo"|"doing"|"done"`; `interface Task { id; project_id; title; spec; prd: string|null; priority: number; status: Status; depends_on: string[]; verify: string|null; created_by: "human"|"ai"; created_at: string; done_at: string|null }`; `interface ProgressEntry { id: number; project_id: string; task_id: string|null; ts: string; author: "human"|"ai"; text: string }`.
- Produces (store.ts): `ensureProject(db, id, name): void`; `interface NewTask { id; project; title; spec; prd?; priority?; depends_on?: string[]; verify?; created_by: "human"|"ai" }`; `addTask(db, t: NewTask): string`; `getTask(db, id): Task|null`; `listTasks(db, project, status?): Task[]`.

- [ ] **Step 1: Create `src/types.ts`**

```ts
export type Status = "todo" | "doing" | "done";

export interface Task {
  id: string;
  project_id: string;
  title: string;
  spec: string;
  prd: string | null;
  priority: number;
  status: Status;
  depends_on: string[];
  verify: string | null;
  created_by: "human" | "ai";
  created_at: string;
  done_at: string | null;
}

export interface ProgressEntry {
  id: number;
  project_id: string;
  task_id: string | null;
  ts: string;
  author: "human" | "ai";
  text: string;
}
```

- [ ] **Step 2: Write the failing tests `test/store.test.ts`**

```ts
import { test, expect } from "vitest";
import { openRalphDb } from "../src/db.js";
import { ensureProject, addTask, getTask, listTasks } from "../src/store.js";

function db() { return openRalphDb(":memory:"); }

test("addTask inserts a todo task and getTask round-trips depends_on", () => {
  const d = db();
  ensureProject(d, "proj", "Proj");
  addTask(d, { id: "t1", project: "proj", title: "First", spec: "do x",
    depends_on: ["t0"], created_by: "ai" });
  const t = getTask(d, "t1");
  expect(t?.status).toBe("todo");
  expect(t?.depends_on).toEqual(["t0"]);
  expect(t?.created_by).toBe("ai");
});

test("listTasks orders by priority desc then created_at asc, filters by status", () => {
  const d = db();
  ensureProject(d, "proj", "Proj");
  addTask(d, { id: "a", project: "proj", title: "A", spec: "s", priority: 1, created_by: "ai" });
  addTask(d, { id: "b", project: "proj", title: "B", spec: "s", priority: 5, created_by: "ai" });
  const todo = listTasks(d, "proj", "todo");
  expect(todo.map((t) => t.id)).toEqual(["b", "a"]);
  expect(listTasks(d, "proj", "done")).toEqual([]);
});

test("ensureProject is idempotent", () => {
  const d = db();
  ensureProject(d, "proj", "Proj");
  ensureProject(d, "proj", "Proj again");
  const n = d.prepare("SELECT COUNT(*) c FROM projects").get() as any;
  expect(n.c).toBe(1);
});
```

- [ ] **Step 3: Run the tests, verify they FAIL**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — `Cannot find module '../src/store.js'`.

- [ ] **Step 4: Create `src/store.ts` (this task's functions only)**

```ts
import type { DB } from "./db.js";
import type { Task, Status } from "./types.js";

const now = () => new Date().toISOString();

export function ensureProject(db: DB, id: string, name: string): void {
  db.prepare(
    `INSERT INTO projects(id,name,created_at,active_run) VALUES(?,?,?,0)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, name, now());
}

export interface NewTask {
  id: string; project: string; title: string; spec: string;
  prd?: string; priority?: number; depends_on?: string[];
  verify?: string; created_by: "human" | "ai";
}

export function addTask(db: DB, t: NewTask): string {
  db.prepare(
    `INSERT INTO tasks(id,project_id,title,spec,prd,priority,status,depends_on,verify,created_by,created_at)
     VALUES(?,?,?,?,?,?,'todo',?,?,?,?)`,
  ).run(
    t.id, t.project, t.title, t.spec, t.prd ?? null, t.priority ?? 0,
    JSON.stringify(t.depends_on ?? []), t.verify ?? null, t.created_by, now(),
  );
  return t.id;
}

function rowToTask(r: any): Task {
  return { ...r, depends_on: JSON.parse(r.depends_on) } as Task;
}

export function getTask(db: DB, id: string): Task | null {
  const r = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id);
  return r ? rowToTask(r) : null;
}

export function listTasks(db: DB, project: string, status?: Status): Task[] {
  const rows = status
    ? db.prepare(
        `SELECT * FROM tasks WHERE project_id=? AND status=?
         ORDER BY priority DESC, created_at ASC`,
      ).all(project, status)
    : db.prepare(
        `SELECT * FROM tasks WHERE project_id=? ORDER BY priority DESC, created_at ASC`,
      ).all(project);
  return rows.map(rowToTask);
}
```

- [ ] **Step 5: Run the tests, verify they PASS**

Run: `npx vitest run test/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-ralph/src/types.ts agent/extensions/pi-ralph/src/store.ts \
        agent/extensions/pi-ralph/test/store.test.ts
git commit -m "feat(ralph): task/project store — create + list"
```

---

### Task 3: Scheduling + lifecycle — nextTask, claim, complete, progress

**Files:**
- Modify: `agent/extensions/pi-ralph/src/store.ts` (append functions)
- Test: `agent/extensions/pi-ralph/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `ensureProject`, `addTask`, `getTask`, `listTasks` from Task 2.
- Produces: `nextTask(db, project): Task|null` (highest-priority todo whose every `depends_on` id is done); `claimTask(db, id): void` (→ doing); `appendProgress(db, project, text, author, taskId?): void`; `completeTask(db, id, summary, author?="ai"): void` (→ done + done_at, appends `"<id>: <summary>"` to progress, in one transaction); `recentProgress(db, project, n): ProgressEntry[]` (oldest-first); `setActiveRun(db, project, active: boolean): void`.

- [ ] **Step 1: Write the failing tests `test/lifecycle.test.ts`**

```ts
import { test, expect } from "vitest";
import { openRalphDb } from "../src/db.js";
import {
  ensureProject, addTask, getTask,
  nextTask, claimTask, completeTask, appendProgress, recentProgress, setActiveRun,
} from "../src/store.js";

function seeded() {
  const d = openRalphDb(":memory:");
  ensureProject(d, "p", "P");
  addTask(d, { id: "low", project: "p", title: "Low", spec: "s", priority: 1, created_by: "ai" });
  addTask(d, { id: "high", project: "p", title: "High", spec: "s", priority: 9, created_by: "ai" });
  addTask(d, { id: "blocked", project: "p", title: "Blocked", spec: "s", priority: 99,
    depends_on: ["high"], created_by: "ai" });
  return d;
}

test("nextTask returns highest-priority UNBLOCKED todo (skips blocked)", () => {
  const d = seeded();
  expect(nextTask(d, "p")?.id).toBe("high"); // 'blocked' has higher priority but unmet dep
});

test("completing the dep unblocks the dependent task", () => {
  const d = seeded();
  claimTask(d, "high");
  completeTask(d, "high", "done high");
  // now 'blocked' (priority 99) is unblocked and outranks 'low'
  expect(nextTask(d, "p")?.id).toBe("blocked");
});

test("completeTask marks done, stamps done_at, and appends progress", () => {
  const d = seeded();
  completeTask(d, "low", "finished low work");
  const t = getTask(d, "low");
  expect(t?.status).toBe("done");
  expect(t?.done_at).not.toBeNull();
  const log = recentProgress(d, "p", 10);
  expect(log.at(-1)?.text).toBe("low: finished low work");
});

test("recentProgress returns the last n, oldest-first", () => {
  const d = seeded();
  appendProgress(d, "p", "one", "ai");
  appendProgress(d, "p", "two", "human");
  const log = recentProgress(d, "p", 2);
  expect(log.map((e) => e.text)).toEqual(["one", "two"]);
  expect(log[1].author).toBe("human");
});

test("nextTask returns null when no unblocked todos remain", () => {
  const d = openRalphDb(":memory:");
  ensureProject(d, "p", "P");
  expect(nextTask(d, "p")).toBeNull();
});

test("setActiveRun toggles the project flag", () => {
  const d = seeded();
  setActiveRun(d, "p", true);
  const row = d.prepare("SELECT active_run FROM projects WHERE id='p'").get() as any;
  expect(row.active_run).toBe(1);
});
```

- [ ] **Step 2: Run the tests, verify they FAIL**

Run: `npx vitest run test/lifecycle.test.ts`
Expected: FAIL — `nextTask` (and others) `is not a function` / not exported.

- [ ] **Step 3: Append to `src/store.ts`**

```ts
import type { ProgressEntry } from "./types.js";

export function nextTask(db: DB, project: string): Task | null {
  const todos = listTasks(db, project, "todo");
  const doneIds = new Set(listTasks(db, project, "done").map((t) => t.id));
  for (const t of todos) if (t.depends_on.every((d) => doneIds.has(d))) return t;
  return null;
}

export function claimTask(db: DB, id: string): void {
  db.prepare(`UPDATE tasks SET status='doing' WHERE id=?`).run(id);
}

export function appendProgress(
  db: DB, project: string, text: string, author: "human" | "ai", taskId?: string,
): void {
  db.prepare(
    `INSERT INTO progress(project_id,task_id,ts,author,text) VALUES(?,?,?,?,?)`,
  ).run(project, taskId ?? null, now(), author, text);
}

export function completeTask(
  db: DB, id: string, summary: string, author: "human" | "ai" = "ai",
): void {
  const tx = db.transaction(() => {
    const t = getTask(db, id);
    if (!t) throw new Error(`no such task: ${id}`);
    db.prepare(`UPDATE tasks SET status='done', done_at=? WHERE id=?`).run(now(), id);
    appendProgress(db, t.project_id, `${id}: ${summary}`, author, id);
  });
  tx();
}

export function recentProgress(db: DB, project: string, n: number): ProgressEntry[] {
  const rows = db.prepare(
    `SELECT * FROM progress WHERE project_id=? ORDER BY id DESC LIMIT ?`,
  ).all(project, n) as ProgressEntry[];
  return rows.reverse();
}

export function setActiveRun(db: DB, project: string, active: boolean): void {
  db.prepare(`UPDATE projects SET active_run=? WHERE id=?`).run(active ? 1 : 0, project);
}
```

- [ ] **Step 4: Run the tests, verify they PASS**

Run: `npx vitest run test/lifecycle.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-ralph/src/store.ts agent/extensions/pi-ralph/test/lifecycle.test.ts
git commit -m "feat(ralph): nextTask (deps), claim/complete, progress log"
```

---

### Task 4: Board + prompt rendering

**Files:**
- Create: `agent/extensions/pi-ralph/src/board.ts`
- Create: `agent/extensions/pi-ralph/src/prompts.ts`
- Test: `agent/extensions/pi-ralph/test/board.test.ts`

**Interfaces:**
- Consumes: `listTasks`, `recentProgress` from store.
- Produces (board.ts): `renderBoard(db, project): string`.
- Produces (prompts.ts): `SENTINEL = "PROMISE COMPLETE"`; `protocolBlock(project, board): string`; `KICKOFF(project): string`; `CONTINUATION: string`.

- [ ] **Step 1: Write the failing tests `test/board.test.ts`**

```ts
import { test, expect } from "vitest";
import { openRalphDb } from "../src/db.js";
import { ensureProject, addTask, claimTask } from "../src/store.js";
import { renderBoard } from "../src/board.js";
import { protocolBlock, SENTINEL } from "../src/prompts.js";

function seeded() {
  const d = openRalphDb(":memory:");
  ensureProject(d, "p", "P");
  addTask(d, { id: "todo1", project: "p", title: "T1", spec: "s", priority: 2, created_by: "ai" });
  addTask(d, { id: "doing1", project: "p", title: "D1", spec: "s", created_by: "ai" });
  claimTask(d, "doing1");
  return d;
}

test("renderBoard shows TODO/DOING/DONE columns with task ids", () => {
  const board = renderBoard(seeded(), "p");
  expect(board).toContain("TODO");
  expect(board).toContain("todo1");
  expect(board).toContain("DOING");
  expect(board).toContain("doing1");
  expect(board).toContain("DONE");
});

test("protocolBlock embeds the board, the rules, and the sentinel", () => {
  const block = protocolBlock("p", renderBoard(seeded(), "p"));
  expect(block).toContain("active run: p");
  expect(block).toContain("ralph_next");
  expect(block).toContain(SENTINEL);
  expect(block).toContain("todo1"); // board is embedded
});
```

- [ ] **Step 2: Run the tests, verify they FAIL**

Run: `npx vitest run test/board.test.ts`
Expected: FAIL — `Cannot find module '../src/board.js'`.

- [ ] **Step 3: Create `src/board.ts`**

```ts
import type { DB } from "./db.js";
import type { Status } from "./types.js";
import { listTasks, recentProgress } from "./store.js";

export function renderBoard(db: DB, project: string): string {
  const line = (label: string, s: Status) => {
    const ids = listTasks(db, project, s).map((t) => `‹p${t.priority}›${t.id}`);
    return `${label}: ${ids.join(", ") || "—"}`;
  };
  const prog = recentProgress(db, project, 6)
    .map((p) => `  · ${p.ts.slice(11, 16)} ${p.author} ${p.text}`)
    .join("\n") || "  (none)";
  return [
    `project: ${project}`,
    line("TODO", "todo"),
    line("DOING", "doing"),
    line("DONE", "done"),
    "progress (recent):",
    prog,
  ].join("\n");
}
```

- [ ] **Step 4: Create `src/prompts.ts`**

```ts
export const SENTINEL = "PROMISE COMPLETE";

export function protocolBlock(project: string, board: string): string {
  return [
    `## Ralph kanban — active run: ${project}`,
    "Work the backlog ONE task at a time:",
    "1. ralph_next → highest-priority unblocked task. Work ONLY that task.",
    "2. If it has a `verify` command, run it and make it pass before completing.",
    "3. ralph_claim(id) when you start; ralph_complete(id, summary) when done.",
    "4. ralph_progress: leave a note for the next iteration.",
    "5. git commit this one task's work.",
    `6. Continue to the next task. If ralph_next returns nothing, output exactly: ${SENTINEL}`,
    "Keep tasks small; keep changes small.",
    "",
    board,
  ].join("\n");
}

export const KICKOFF = (project: string): string =>
  `Start the Ralph run for ${project}. Follow the kanban protocol above. Begin with ralph_next.`;

export const CONTINUATION =
  `Task committed. Continue: ralph_next for the next task, or output exactly "${SENTINEL}" if the board is empty.`;
```

- [ ] **Step 5: Run the tests, verify they PASS**

Run: `npx vitest run test/board.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-ralph/src/board.ts agent/extensions/pi-ralph/src/prompts.ts \
        agent/extensions/pi-ralph/test/board.test.ts
git commit -m "feat(ralph): board + protocol/kickoff/continuation prompts"
```

---

### Task 5: Loop decision (pure)

**Files:**
- Create: `agent/extensions/pi-ralph/src/loop.ts`
- Test: `agent/extensions/pi-ralph/test/loop.test.ts`

**Interfaces:**
- Produces: `interface RunState { active: boolean; project: string; iterations: number; max: number; once: boolean; pendingContinue: boolean }`; `type LoopAction = "idle"|"stop-once"|"stop-max"|"stop-empty"|"continue"`; `loopDecision(s: RunState, hasNext: boolean): LoopAction`.
- Note: `iterations` counts COMPLETED tasks (incremented by `ralph_complete` in Task 6). `pendingContinue` is set true by `ralph_complete` and cleared by the `turn_end` driver (Task 7).

- [ ] **Step 1: Write the failing tests `test/loop.test.ts`**

```ts
import { test, expect } from "vitest";
import { loopDecision, type RunState } from "../src/loop.js";

const base = (over: Partial<RunState> = {}): RunState => ({
  active: true, project: "p", iterations: 0, max: 20, once: false, pendingContinue: true, ...over,
});

test("idle when run inactive", () => {
  expect(loopDecision(base({ active: false }), true)).toBe("idle");
});

test("idle when no task just completed (pendingContinue false)", () => {
  expect(loopDecision(base({ pendingContinue: false }), true)).toBe("idle");
});

test("once mode stops after a completion", () => {
  expect(loopDecision(base({ once: true }), true)).toBe("stop-once");
});

test("stops at max iterations", () => {
  expect(loopDecision(base({ iterations: 20, max: 20 }), true)).toBe("stop-max");
});

test("stops when the board is empty", () => {
  expect(loopDecision(base(), false)).toBe("stop-empty");
});

test("continues when active, pending, under max, and work remains", () => {
  expect(loopDecision(base({ iterations: 3 }), true)).toBe("continue");
});
```

- [ ] **Step 2: Run the tests, verify they FAIL**

Run: `npx vitest run test/loop.test.ts`
Expected: FAIL — `Cannot find module '../src/loop.js'`.

- [ ] **Step 3: Create `src/loop.ts`**

```ts
export interface RunState {
  active: boolean;
  project: string;
  iterations: number;   // completed tasks this run
  max: number;
  once: boolean;
  pendingContinue: boolean;
}

export type LoopAction = "idle" | "stop-once" | "stop-max" | "stop-empty" | "continue";

export function loopDecision(s: RunState, hasNext: boolean): LoopAction {
  if (!s.active || !s.pendingContinue) return "idle";
  if (s.once) return "stop-once";
  if (s.iterations >= s.max) return "stop-max";
  if (!hasNext) return "stop-empty";
  return "continue";
}
```

- [ ] **Step 4: Run the tests, verify they PASS**

Run: `npx vitest run test/loop.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-ralph/src/loop.ts agent/extensions/pi-ralph/test/loop.test.ts
git commit -m "feat(ralph): pure loop-decision function"
```

---

### Task 6: AI tools (ralph_*)

**Files:**
- Create: `agent/extensions/pi-ralph/src/tools.ts`
- Test: `agent/extensions/pi-ralph/test/tools.test.ts`

**Interfaces:**
- Consumes: `store.*` (Tasks 2–3), `renderBoard` (Task 4), `RunState` (Task 5).
- Produces: `interface RalphCtx { db: DB; run: RunState }`; factories `makeRalphAdd|makeRalphList|makeRalphNext|makeRalphClaim|makeRalphComplete|makeRalphProgress(ctx: RalphCtx)`, each returning a pi tool object `{ name, label, description, promptSnippet, parameters, execute(id, p) }`.
- Behavior contract: `ralph_complete.execute` increments `ctx.run.iterations` and sets `ctx.run.pendingContinue = true` (the loop heartbeat). Tool-created tasks use `created_by: "ai"`.

- [ ] **Step 1: Write the failing tests `test/tools.test.ts`**

```ts
import { test, expect } from "vitest";
import { openRalphDb } from "../src/db.js";
import { getTask, listTasks, recentProgress } from "../src/store.js";
import type { RunState } from "../src/loop.js";
import {
  makeRalphAdd, makeRalphNext, makeRalphClaim, makeRalphComplete, makeRalphProgress,
  type RalphCtx,
} from "../src/tools.js";

function ctx(): RalphCtx {
  const run: RunState = { active: true, project: "p", iterations: 0, max: 20, once: false, pendingContinue: false };
  return { db: openRalphDb(":memory:"), run };
}

test("ralph_add inserts an ai-created todo task", async () => {
  const c = ctx();
  const out = await makeRalphAdd(c).execute("1", { project: "p", title: "Add login", spec: "user can log in" });
  expect(out.content[0].text).toContain("login");
  const tasks = listTasks(c.db, "p", "todo");
  expect(tasks).toHaveLength(1);
  expect(tasks[0].created_by).toBe("ai");
});

test("ralph_next returns the highest-priority unblocked task as text", async () => {
  const c = ctx();
  await makeRalphAdd(c).execute("1", { project: "p", title: "Low", spec: "s", priority: 1 });
  await makeRalphAdd(c).execute("2", { project: "p", title: "High", spec: "s", priority: 9 });
  const out = await makeRalphNext(c).execute("3", { project: "p" });
  expect(out.content[0].text).toContain("high");
});

test("ralph_complete marks done, logs progress, and arms the loop", async () => {
  const c = ctx();
  await makeRalphAdd(c).execute("1", { project: "p", title: "Task one", spec: "s" });
  await makeRalphClaim(c).execute("2", { id: "task-one" });
  const out = await makeRalphComplete(c).execute("3", { id: "task-one", summary: "did it" });
  expect(out.content[0].text).toContain("task-one");
  expect(getTask(c.db, "task-one")?.status).toBe("done");
  expect(recentProgress(c.db, "p", 1)[0].text).toBe("task-one: did it");
  expect(c.run.pendingContinue).toBe(true);
  expect(c.run.iterations).toBe(1);
});

test("ralph_progress appends an ai note", async () => {
  const c = ctx();
  await makeRalphAdd(c).execute("1", { project: "p", title: "x", spec: "s" });
  await makeRalphProgress(c).execute("2", { project: "p", text: "learned a thing" });
  expect(recentProgress(c.db, "p", 1)[0].text).toBe("learned a thing");
});
```

- [ ] **Step 2: Run the tests, verify they FAIL**

Run: `npx vitest run test/tools.test.ts`
Expected: FAIL — `Cannot find module '../src/tools.js'`.

- [ ] **Step 3: Create `src/tools.ts`**

```ts
import { Type } from "typebox";
import type { DB } from "./db.js";
import type { RunState } from "./loop.js";
import * as store from "./store.js";
import { renderBoard } from "./board.js";

export interface RalphCtx { db: DB; run: RunState; }

const txt = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";

export function makeRalphAdd(ctx: RalphCtx) {
  return {
    name: "ralph_add",
    label: "Ralph Add Task",
    description: "Add a task to a project's Ralph kanban backlog. `spec` = the behavior + acceptance criteria; optional `verify` = a shell command to confirm done.",
    promptSnippet: "ralph_add: add a kanban task (spec + acceptance)",
    parameters: Type.Object({
      project: Type.String(),
      title: Type.String(),
      spec: Type.String(),
      prd: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Number()),
      depends_on: Type.Optional(Type.Array(Type.String())),
      verify: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any) {
      store.ensureProject(ctx.db, p.project, p.project);
      const id = slug(p.title);
      store.addTask(ctx.db, {
        id, project: p.project, title: p.title, spec: p.spec, prd: p.prd,
        priority: p.priority, depends_on: p.depends_on, verify: p.verify, created_by: "ai",
      });
      return txt(`Added task '${id}' to ${p.project}.`);
    },
  };
}

export function makeRalphList(ctx: RalphCtx) {
  return {
    name: "ralph_list",
    label: "Ralph List",
    description: "Show the kanban board (todo/doing/done + recent progress) for a project.",
    promptSnippet: "ralph_list: show the kanban board",
    parameters: Type.Object({ project: Type.String() }),
    async execute(_id: string, p: any) {
      return txt(renderBoard(ctx.db, p.project));
    },
  };
}

export function makeRalphNext(ctx: RalphCtx) {
  return {
    name: "ralph_next",
    label: "Ralph Next",
    description: "Return the single highest-priority UNBLOCKED todo task for a project (or report the board is empty).",
    promptSnippet: "ralph_next: pick the next task",
    parameters: Type.Object({ project: Type.String() }),
    async execute(_id: string, p: any) {
      const t = store.nextTask(ctx.db, p.project);
      if (!t) return txt("No unblocked todo tasks. If the board is empty, output PROMISE COMPLETE.");
      const dep = t.depends_on.length ? ` depends_on=${JSON.stringify(t.depends_on)}` : "";
      const ver = t.verify ? `\nverify: ${t.verify}` : "";
      return txt(`Next: ${t.id} (priority ${t.priority})${dep}\nspec: ${t.spec}${t.prd ? `\nprd: ${t.prd}` : ""}${ver}`);
    },
  };
}

export function makeRalphClaim(ctx: RalphCtx) {
  return {
    name: "ralph_claim",
    label: "Ralph Claim",
    description: "Mark a task as in-progress (todo → doing).",
    promptSnippet: "ralph_claim: start a task",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id: string, p: any) {
      store.claimTask(ctx.db, p.id);
      return txt(`Claimed '${p.id}' (doing).`);
    },
  };
}

export function makeRalphComplete(ctx: RalphCtx) {
  return {
    name: "ralph_complete",
    label: "Ralph Complete",
    description: "Mark a task done and log a one-line summary to the project progress note. Call this only after the work is committed and (if present) its `verify` passed.",
    promptSnippet: "ralph_complete: finish a task",
    parameters: Type.Object({ id: Type.String(), summary: Type.String() }),
    async execute(_id: string, p: any) {
      store.completeTask(ctx.db, p.id, p.summary, "ai");
      ctx.run.iterations += 1;
      ctx.run.pendingContinue = true;
      return txt(`Completed '${p.id}'. Progress logged.`);
    },
  };
}

export function makeRalphProgress(ctx: RalphCtx) {
  return {
    name: "ralph_progress",
    label: "Ralph Progress",
    description: "Append a free-text note (learnings / handoff for the next iteration) to a project's progress log.",
    promptSnippet: "ralph_progress: append a progress note",
    parameters: Type.Object({
      project: Type.String(),
      text: Type.String(),
      task_id: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any) {
      store.appendProgress(ctx.db, p.project, p.text, "ai", p.task_id);
      return txt("Noted.");
    },
  };
}
```

- [ ] **Step 4: Run the tests, verify they PASS**

Run: `npx vitest run test/tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-ralph/src/tools.ts agent/extensions/pi-ralph/test/tools.test.ts
git commit -m "feat(ralph): ralph_* AI tools over the store"
```

---

### Task 7: Extension wiring (index.ts) — injection, loop driver, commands

**Files:**
- Create: `agent/extensions/pi-ralph/index.ts`
- Test: `agent/extensions/pi-ralph/test/wiring.test.ts`

**Interfaces:**
- Consumes: everything above. `pi.registerTool`, `pi.registerCommand(name, { description, handler:(args,c)=>... })`, `pi.on("before_agent_start"|"turn_end", ...)`, `pi.sendUserMessage(text)`. The `turn_end` ctx `c` exposes `c.compact({ onComplete, onError })`, `c.ui.notify(msg, level)`, `c.hasUI`.
- Produces: the default-exported `(pi) => void` extension entry. DB opened from `process.env["RALPH_DB"] ?? <cwd>/.pi/ralph/ralph.db`. A module-local `run: RunState` shared between tools, injection, and the driver.

- [ ] **Step 1: Write the failing test `test/wiring.test.ts`**

```ts
import { test, expect, beforeEach } from "vitest";
import ralph from "../index.js";

function mockPi() {
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  const hooks: Record<string, Function> = {};
  const sent: string[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.push(t),
    registerCommand: (n: string, c: any) => { commands[n] = c; },
    on: (e: string, h: Function) => { hooks[e] = h; },
    sendUserMessage: (m: string) => sent.push(m),
  };
  return { pi, tools, commands, hooks, sent };
}

function turnCtx() {
  const compacts: any[] = [];
  const c = {
    compact: (o: any) => { compacts.push(o); o.onComplete?.(); },
    ui: { notify: () => {} },
    hasUI: false,
  };
  return { c, compacts };
}

beforeEach(() => { process.env["RALPH_DB"] = ":memory:"; });

test("registers the six ralph tools and the commands", () => {
  const m = mockPi();
  ralph(m.pi);
  expect(m.tools.map((t) => t.name).sort()).toEqual(
    ["ralph_add", "ralph_claim", "ralph_complete", "ralph_list", "ralph_next", "ralph_progress"],
  );
  for (const cmd of ["ralph", "ralph-run", "ralph-add", "ralph-note"]) {
    expect(m.commands[cmd]).toBeDefined();
  }
});

test("/ralph-run activates the run and injects the kickoff prompt", async () => {
  const m = mockPi();
  ralph(m.pi);
  await m.commands["ralph-run"].handler("demo", { hasUI: false, ui: { notify: () => {} } });
  expect(m.sent.some((s) => s.includes("Ralph run for demo"))).toBe(true);
});

test("turn_end continues (compacts + injects) after a completion with work remaining", async () => {
  const m = mockPi();
  ralph(m.pi);
  // start a run + add a task via the registered tools so they share `run`
  await m.commands["ralph-run"].handler("demo --max 5", { hasUI: false, ui: { notify: () => {} } });
  const add = m.tools.find((t) => t.name === "ralph_add");
  await add.execute("x", { project: "demo", title: "one", spec: "s" });
  await add.execute("y", { project: "demo", title: "two", spec: "s" });
  const complete = m.tools.find((t) => t.name === "ralph_complete");
  await complete.execute("z", { id: "one", summary: "done one" }); // arms pendingContinue

  const { c, compacts } = turnCtx();
  await m.hooks["turn_end"]({}, c);
  expect(compacts).toHaveLength(1);                 // compacted after the task
  expect(m.sent.some((s) => s.includes("Continue"))).toBe(true);
});

test("before_agent_start injects the board only while a run is active", async () => {
  const m = mockPi();
  ralph(m.pi);
  const before = m.hooks["before_agent_start"];
  expect(await before({ systemPrompt: "BASE" })).toBeUndefined();    // no run yet
  await m.commands["ralph-run"].handler("demo", { hasUI: false, ui: { notify: () => {} } });
  const r = await before({ systemPrompt: "BASE" });
  expect(r.systemPrompt).toContain("Ralph kanban — active run: demo");
});
```

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `npx vitest run test/wiring.test.ts`
Expected: FAIL — `Cannot find module '../index.js'`.

- [ ] **Step 3: Create `index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";
import { openRalphDb } from "./src/db.js";
import * as store from "./src/store.js";
import { renderBoard } from "./src/board.js";
import { protocolBlock, KICKOFF, CONTINUATION } from "./src/prompts.js";
import { loopDecision, type RunState } from "./src/loop.js";
import {
  makeRalphAdd, makeRalphList, makeRalphNext, makeRalphClaim, makeRalphComplete, makeRalphProgress,
  type RalphCtx,
} from "./src/tools.js";

export default function (pi: ExtensionAPI) {
  const dbFile = process.env["RALPH_DB"]
    ?? path.join(process.cwd(), ".pi", "ralph", "ralph.db");
  const db = openRalphDb(dbFile);
  const run: RunState = {
    active: false, project: "", iterations: 0, max: 20, once: false, pendingContinue: false,
  };
  const ctx: RalphCtx = { db, run };

  for (const make of [
    makeRalphAdd, makeRalphList, makeRalphNext, makeRalphClaim, makeRalphComplete, makeRalphProgress,
  ]) pi.registerTool(make(ctx) as any);

  // Re-inject the protocol + live board every turn while a run is active
  // (survives compaction — board state lives in SQLite, not the transcript).
  pi.on("before_agent_start", async (event: any) => {
    if (!run.active) return;
    try {
      const block = protocolBlock(run.project, renderBoard(db, run.project));
      return { systemPrompt: event.systemPrompt + "\n\n" + block };
    } catch { return; } // fail open
  });

  // Loop driver: after a completion, compact and inject the next iteration —
  // or stop on empty board / max / --once.
  pi.on("turn_end", async (_event: any, c: any) => {
    try {
      const action = loopDecision(run, store.nextTask(db, run.project) !== null);
      run.pendingContinue = false;
      if (action === "idle") return;
      if (action === "continue") {
        c.compact({
          onComplete: () => pi.sendUserMessage(CONTINUATION),
          onError: (e: any) => c.hasUI && c.ui.notify(`Ralph compact failed: ${e?.message ?? e}`, "warning"),
        });
        return;
      }
      run.active = false;
      store.setActiveRun(db, run.project, false);
      const why = action === "stop-empty" ? "PROMISE COMPLETE — board empty"
        : action === "stop-max" ? `stopped at max ${run.max} iterations`
        : "single iteration done (--once)";
      if (c.hasUI) c.ui.notify(`Ralph [${run.project}]: ${why}`, "info");
    } catch { return; } // fail open
  });

  pi.registerCommand("ralph", {
    description: "Show the Ralph board: /ralph <project>",
    handler: async (args: string, c: any) => {
      const project = (args ?? "").trim() || run.project;
      if (!project) { if (c.hasUI) c.ui.notify("usage: /ralph <project>", "warning"); return; }
      if (c.hasUI) c.ui.notify(renderBoard(db, project), "info");
    },
  });

  pi.registerCommand("ralph-run", {
    description: "Start a Ralph run: /ralph-run <project> [--once] [--max N]",
    handler: async (args: string, c: any) => {
      const toks = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const project = toks[0];
      if (!project) { if (c.hasUI) c.ui.notify("usage: /ralph-run <project> [--once] [--max N]", "warning"); return; }
      const mi = toks.indexOf("--max");
      run.active = true;
      run.project = project;
      run.iterations = 0;
      run.pendingContinue = false;
      run.once = toks.includes("--once");
      run.max = mi >= 0 ? Number(toks[mi + 1]) : 20;
      store.ensureProject(db, project, project);
      store.setActiveRun(db, project, true);
      pi.sendUserMessage(KICKOFF(project));
    },
  });

  pi.registerCommand("ralph-add", {
    description: "Add a task: /ralph-add <project> :: <title> :: <spec>",
    handler: async (args: string, c: any) => {
      const parts = (args ?? "").split("::").map((s) => s.trim());
      if (parts.length < 3 || !parts[0] || !parts[1]) {
        if (c.hasUI) c.ui.notify("usage: /ralph-add <project> :: <title> :: <spec>", "warning");
        return;
      }
      const [project, title, spec] = parts;
      store.ensureProject(db, project, project);
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
      store.addTask(db, { id, project, title, spec, created_by: "human" });
      if (c.hasUI) c.ui.notify(`Added '${id}' to ${project}.`, "info");
    },
  });

  pi.registerCommand("ralph-note", {
    description: "Append a progress note: /ralph-note <project> <text>",
    handler: async (args: string, c: any) => {
      const s = (args ?? "").trim();
      const sp = s.indexOf(" ");
      if (sp < 0) { if (c.hasUI) c.ui.notify("usage: /ralph-note <project> <text>", "warning"); return; }
      store.appendProgress(db, s.slice(0, sp), s.slice(sp + 1), "human");
    },
  });

  void os; // (reserved: default DB path may move under os.homedir() for a global board)
}
```

- [ ] **Step 4: Run the test, verify it PASSES**

Run: `npx vitest run test/wiring.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-ralph/index.ts agent/extensions/pi-ralph/test/wiring.test.ts
git commit -m "feat(ralph): wire tools, board injection, loop driver, commands"
```

---

### Task 8: Manual smoke test + README

**Files:**
- Create: `agent/extensions/pi-ralph/README.md`

**Interfaces:** none (docs + manual verification).

- [ ] **Step 1: Manual smoke (real pi, throwaway project)**

```bash
# from a scratch git repo:
pi --print "/ralph-add demo :: hello task :: print hello and exit 0"
pi --print "/ralph demo"          # should show the board with 'hello-task' in TODO
```
Expected: `/ralph demo` prints a board listing `hello-task` under TODO. (A full AFK run — `/ralph-run demo` — is exercised once the surrounding agent loop is trusted; start with `--once`.)

- [ ] **Step 2: Write `README.md`**

```markdown
# pi-ralph — Ralph kanban for pi

Runs a Ralph loop over a SQLite-backed kanban: the agent works tasks one at a
time, context compacted after each, until the board is empty.

## Use
- `/ralph-add <project> :: <title> :: <spec>` — add a task (human).
- `ralph_add` tool — add a task (AI).
- `/ralph <project>` — view the board + recent progress (read-only).
- `/ralph-run <project> [--once] [--max N]` — start a run (`--once` = one task, human-in-loop).
- `/ralph-note <project> <text>` — append a human note.

## How it works
A run sets `RunState.active`; `before_agent_start` re-injects the protocol + live
board each turn (survives compaction — state is in SQLite). `ralph_complete` arms
`pendingContinue`; the `turn_end` driver compacts and injects the next iteration,
or stops on empty board / `--max` / `--once`.

## Notes
- DB: `<cwd>/.pi/ralph/ralph.db` (override with `RALPH_DB`; `:memory:` in tests).
- Done-gate is **soft**: the agent self-reports. Keep tasks small, give each a
  `verify` command, and keep CI green — that's the real safety net.

## Dev
`pnpm install && pnpm test` · `pnpm run check` (typecheck).
```

- [ ] **Step 3: Commit**

```bash
git add agent/extensions/pi-ralph/README.md
git commit -m "docs(ralph): README — usage + architecture"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Tools (§5)→T6; human commands (§6)→T7; read-only board (§7)→T4+T7; injected prompts (§8)→T4+T7; in-session loop + compact-after-every-task (§3)→T5+T7; SQLite model (§4)→T1–T3; soft gate (§9)→`verify` field carried (T2) + prompt wording (T4), no hard enforcement by design.
- **Deferred (spec §10/§11):** multi-project concurrency, deadlock surfacing, TUI view (the board renders to chat via `/ralph` for v1), external fresh-pi runner, hard verify gate. None block v1.
- **Type consistency:** `RunState` fields and the `make*`/`store.*` signatures are identical across T5–T7. `RALPH_DB=:memory:` is the test seam used in every suite.

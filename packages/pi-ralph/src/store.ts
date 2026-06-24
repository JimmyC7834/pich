import type { DB } from "./db.js";
import type { Task, Status, ProgressEntry } from "./types.js";

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

export function nextTask(db: DB, project: string): Task | null {
  const todos = listTasks(db, project, "todo");
  const doneIds = new Set(listTasks(db, project, "done").map((t) => t.id));
  for (const t of todos) if (t.depends_on.every((d) => doneIds.has(d))) return t;
  return null;
}

export function blockedTasks(db: DB, project: string): Task[] {
  const todos = listTasks(db, project, "todo");
  const doneIds = new Set(listTasks(db, project, "done").map((t) => t.id));
  return todos.filter((t) => !t.depends_on.every((d) => doneIds.has(d)));
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
  // node:sqlite has no db.transaction() helper; flat manual tx is faithful here.
  db.exec("BEGIN");
  try {
    const t = getTask(db, id);
    if (!t) throw new Error(`no such task: ${id}`);
    db.prepare(`UPDATE tasks SET status='done', done_at=? WHERE id=?`).run(now(), id);
    appendProgress(db, t.project_id, `${id}: ${summary}`, author, id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function recentProgress(db: DB, project: string, n: number): ProgressEntry[] {
  const rows = db.prepare(
    `SELECT * FROM progress WHERE project_id=? ORDER BY id DESC LIMIT ?`,
  ).all(project, n) as unknown as ProgressEntry[];
  return rows.reverse();
}

export function setActiveRun(db: DB, project: string, active: boolean): void {
  db.prepare(`UPDATE projects SET active_run=? WHERE id=?`).run(active ? 1 : 0, project);
}

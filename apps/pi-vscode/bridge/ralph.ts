import { join } from "node:path";
import { homedir } from "node:os";

export interface RalphTask { id: string; title: string; status: string; priority: number; done_at: string | null; }
export interface RalphProject { id: string; name: string; todo: RalphTask[]; doing: RalphTask[]; done: RalphTask[]; }
export interface RalphSnapshot { projects: RalphProject[]; }

// Same default the pi-ralph extension uses: one global board under the harness root.
function dbFile(): string {
  return process.env["RALPH_DB"] ?? join(homedir(), ".pi", ".pi", "ralph", "ralph.db");
}

// ponytail: borrow pi-ralph's already-compiled better-sqlite3 — same pi process, ABI
// matches — instead of adding a native dep to pi-bridge. Path is fixed by convention.
function driver(): any {
  return require(join(homedir(), ".pi", "agent", "extensions", "pi-ralph", "node_modules", "better-sqlite3"));
}

/** Read the kanban board grouped by project. Open-query-close (board is tiny) for a fresh read each time. */
export function ralphSnapshot(): RalphSnapshot {
  const file = dbFile();
  if (file === ":memory:") return { projects: [] };
  const db = new (driver())(file, { readonly: true, fileMustExist: true });
  try {
    const projects = db.prepare("SELECT id, name FROM projects ORDER BY name").all() as { id: string; name: string }[];
    const tasks = db.prepare("SELECT id, project_id, title, status, priority, done_at FROM tasks").all() as Array<RalphTask & { project_id: string }>;
    const byProject = new Map<string, RalphProject>();
    for (const p of projects) byProject.set(p.id, { id: p.id, name: p.name, todo: [], doing: [], done: [] });
    for (const t of tasks) {
      let proj = byProject.get(t.project_id);
      if (!proj) { proj = { id: t.project_id, name: t.project_id, todo: [], doing: [], done: [] }; byProject.set(t.project_id, proj); }
      const col = (proj as unknown as Record<string, RalphTask[]>)[t.status];
      if (Array.isArray(col)) col.push({ id: t.id, title: t.title, status: t.status, priority: t.priority, done_at: t.done_at });
    }
    const cmp = (a: RalphTask, b: RalphTask) => b.priority - a.priority;
    const out: RalphProject[] = [];
    for (const p of byProject.values()) {
      if (p.todo.length + p.doing.length + p.done.length === 0) continue;
      p.todo.sort(cmp); p.doing.sort(cmp); p.done.sort(cmp);
      out.push(p);
    }
    return { projects: out };
  } finally {
    db.close();
  }
}

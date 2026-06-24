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

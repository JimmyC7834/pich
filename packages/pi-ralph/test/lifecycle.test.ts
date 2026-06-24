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

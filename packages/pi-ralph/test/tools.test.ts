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

test("ralph_next on empty board suggests PROMISE COMPLETE", async () => {
  const c = ctx();
  const out = await makeRalphNext(c).execute("1", { project: "p" });
  expect(out.content[0].text).toContain("PROMISE COMPLETE");
});

test("ralph_next on deadlock returns DEADLOCK not PROMISE COMPLETE", async () => {
  const c = ctx();
  // circular deadlock: A depends on B, B depends on A — neither is runnable
  await makeRalphAdd(c).execute("1", { project: "p", title: "A", spec: "s", depends_on: ["b"] });
  await makeRalphAdd(c).execute("2", { project: "p", title: "B", spec: "s", depends_on: ["a"] });
  const out = await makeRalphNext(c).execute("3", { project: "p" });
  expect(out.content[0].text).toContain("DEADLOCK");
  expect(out.content[0].text).toContain("a");
  expect(out.content[0].text).not.toContain("PROMISE COMPLETE");
});

test("ralph_next still returns unblocked task when work exists", async () => {
  const c = ctx();
  await makeRalphAdd(c).execute("1", { project: "p", title: "Work", spec: "s", priority: 5 });
  const out = await makeRalphNext(c).execute("2", { project: "p" });
  expect(out.content[0].text).toContain("work");
});

test("ralph_add description carries a worked example + authoring rules", () => {
  const desc = makeRalphAdd(ctx()).description;
  expect(desc).toContain("Example:");      // a concrete, well-formed task
  expect(desc).toMatch(/acceptance/i);     // the quality bar
  expect(desc).toContain("verify");        // the done-gate
  expect(desc).toMatch(/small/i);          // sizing rule
});

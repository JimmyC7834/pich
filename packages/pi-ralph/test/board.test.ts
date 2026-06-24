import { test, expect } from "vitest";
import { openRalphDb } from "../src/db.js";
import { renderBoard, protocolBlock, SENTINEL } from "../src/board.js";
import { ensureProject, addTask, claimTask } from "../src/store.js";

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

test("protocolBlock tells the agent to capture follow-up work with ralph_add", () => {
  const block = protocolBlock("p", "BOARD");
  expect(block).toContain("ralph_add");
});

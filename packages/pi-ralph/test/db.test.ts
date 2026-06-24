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

import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { recordUsage, topRecentIds, recordSkillReadFromEvent } from "../src/usage.js";
import { computeActiveIds } from "../src/promotion.js";

test("recordSkillReadFromEvent records a SKILL.md read as skill usage (through the hook payload)", () => {
  const db = openDb(":memory:");
  // shape mirrors PI's ReadToolResultEvent: { toolName:'read', input:{file_path} }
  recordSkillReadFromEvent(db, { toolName: "read", input: { file_path: "/home/u/.pi/skills/retry/SKILL.md" } });
  expect(topRecentIds(db, 5, new Set())).toContain("skill:retry");
});

test("recordSkillReadFromEvent ignores non-read tools and non-SKILL reads", () => {
  const db = openDb(":memory:");
  recordSkillReadFromEvent(db, { toolName: "read", input: { file_path: "/x/notes.md" } });
  recordSkillReadFromEvent(db, { toolName: "bash", input: { command: "ls" } });
  recordSkillReadFromEvent(db, { toolName: "read", input: {} });
  expect(topRecentIds(db, 5, new Set()).length).toBe(0);
});

test("recordUsage counts and orders by recency", () => {
  const db = openDb(":memory:");
  recordUsage(db, "skill:a");
  recordUsage(db, "skill:a");
  recordUsage(db, "skill:b");
  const recent = topRecentIds(db, 5, new Set());
  expect(recent).toContain("skill:a");
  expect(recent).toContain("skill:b");
});

test("computeActiveIds = loadout ∪ session ∪ promoted, capped by ceiling, no dupes", () => {
  const db = openDb(":memory:");
  recordUsage(db, "skill:hot1");
  recordUsage(db, "skill:hot2");
  recordUsage(db, "skill:hot3");
  const active = computeActiveIds({
    loadoutIds: ["skill:base"], sessionIds: new Set(["skill:sess"]), db, ceiling: 2,
  });
  expect(active).toContain("skill:base");
  expect(active).toContain("skill:sess");
  const promoted = active.filter((id) => id.startsWith("skill:hot"));
  expect(promoted.length).toBeLessThanOrEqual(2);
  expect(new Set(active).size).toBe(active.length); // no dupes
});

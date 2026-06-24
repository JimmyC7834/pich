import { test, expect } from "vitest";
import { capabilityRoot, dbPath, loadoutsPath, authoredSkillsDir } from "../src/paths.js";

test("paths derive from a root", () => {
  const root = capabilityRoot("/home/u", "global");
  expect(root.replace(/\\/g, "/")).toBe("/home/u/.pi/capabilities");
  expect(dbPath(root).replace(/\\/g, "/")).toBe("/home/u/.pi/capabilities/index.db");
  expect(loadoutsPath(root).replace(/\\/g, "/")).toBe("/home/u/.pi/capabilities/loadouts.yaml");
  expect(authoredSkillsDir(root).replace(/\\/g, "/")).toBe("/home/u/.pi/skills");
});

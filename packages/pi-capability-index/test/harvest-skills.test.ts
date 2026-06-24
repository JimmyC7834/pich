import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skillToCapability, harvestSkills } from "../src/harvest/skills.js";

test("skillToCapability maps PI Skill -> Capability", () => {
  const cap = skillToCapability({
    name: "brainstorming", description: "turn ideas into designs",
    filePath: "/skills/brainstorming/SKILL.md", baseDir: "/skills/brainstorming",
    sourceInfo: {} as any, disableModelInvocation: true,
  } as any);
  expect(cap.id).toBe("skill:brainstorming");
  expect(cap.kind).toBe("skill");
  expect(cap.searchText.summary).toBe("turn ideas into designs");
  expect((cap.activation as any).filePath).toBe("/skills/brainstorming/SKILL.md");
});

test("harvestSkills loads a packaged skill from an explicit path (incl. disabled)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-skills-"));
  const sdir = path.join(dir, "demo"); mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, "SKILL.md"),
    "---\nname: demo\ndescription: a demo skill\ndisable-model-invocation: true\n---\nbody\n");
  const caps = harvestSkills({ cwd: dir, skillPaths: [sdir], includeDefaults: false });
  const demo = caps.find((c) => c.name === "demo");
  expect(demo).toBeTruthy();                 // disabled skill is still harvested
  expect(demo!.summary).toBe("a demo skill");
});

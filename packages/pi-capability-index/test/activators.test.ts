import { test, expect } from "vitest";
import { activatorFor } from "../src/activators/registry.js";
import type { Capability } from "../src/types.js";

test("SkillActivator marks the skill session-active and returns its file path", () => {
  const session = new Set<string>();
  const act = activatorFor("skill", { sessionActive: session });
  const cap: Capability = {
    id: "skill:demo", kind: "skill", source: "/s", name: "demo", summary: "d",
    searchText: { name: "demo", summary: "d", params: "" },
    activation: { skillDir: "/s/demo", filePath: "/s/demo/SKILL.md" },
  };
  const res = act.activate(cap);
  expect(res.available).toBe("now");
  expect((res.payload as any).filePath).toBe("/s/demo/SKILL.md");
  expect(session.has("skill:demo")).toBe(true);
});

test("unknown kind throws (Phase 3 mcp not built yet)", () => {
  expect(() => activatorFor("mcp" as any, { sessionActive: new Set() })).toThrow();
});

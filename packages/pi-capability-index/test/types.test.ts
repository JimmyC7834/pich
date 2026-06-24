import { test, expect } from "vitest";
import type { Capability, Loadout, CapSearchResult } from "../src/types.js";

test("Capability and Loadout shapes are usable", () => {
  const cap: Capability = {
    id: "skill:brainstorming", kind: "skill", source: "/skills", name: "brainstorming",
    summary: "turn ideas into designs",
    searchText: { name: "brainstorming", summary: "turn ideas into designs", params: "" },
    activation: { skillDir: "/skills/brainstorming", filePath: "/skills/brainstorming/SKILL.md" },
  };
  const lo: Loadout = { name: "base", description: "", skills: [cap.id], tools: [], mcp: [] };
  const res: CapSearchResult = { hits: [], confidence: "low", next_steps: [] };
  expect(cap.kind).toBe("skill");
  expect(lo.skills[0]).toBe("skill:brainstorming");
  expect(res.confidence).toBe("low");
});

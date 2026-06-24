import { test, expect } from "vitest";
import { activatorFor } from "../src/activators/registry.js";
import type { Capability } from "../src/types.js";

function toolCap(name: string): Capability {
  return { id: `tool:pi:${name}`, kind: "tool", source: "pi", name, summary: "",
    searchText: { name, summary: "", params: "" }, activation: { toolName: name } };
}

test("ToolActivator adds the tool to the active set via ToolControl and marks session", () => {
  let active = ["read", "capability_search"];
  const tools = { getActive: () => active, setActive: (n: string[]) => { active = n; } };
  const session = new Set<string>();
  const act = activatorFor("tool", { sessionActive: session, tools });
  const res = act.activate(toolCap("kb_search"));
  expect(res.available).toBe("now");
  expect((res.payload as any).toolName).toBe("kb_search");
  expect(active).toContain("kb_search");
  expect(session.has("tool:pi:kb_search")).toBe(true);
});

test("activating a tool without a ToolControl throws (caught by the activate tool)", () => {
  const act = activatorFor("tool", { sessionActive: new Set() });
  expect(() => act.activate(toolCap("kb_search"))).toThrow();
});

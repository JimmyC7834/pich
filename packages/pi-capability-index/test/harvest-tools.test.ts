import { test, expect } from "vitest";
import { harvestTools, toolToCapability, ALWAYS_ACTIVE } from "../src/harvest/tools.js";

test("toolToCapability maps a ToolInfo to a tool capability with flattened params", () => {
  const cap = toolToCapability({ name: "kb_search", description: "search the library",
    parameters: { type: "object", properties: { query: { type: "string", description: "the query" } } } });
  expect(cap.id).toBe("tool:pi:kb_search");
  expect(cap.kind).toBe("tool");
  expect((cap.activation as any).toolName).toBe("kb_search");
  expect(cap.searchText.params).toContain("query");
});

test("harvestTools skips the always-active allowlist (built-ins + our own tools)", () => {
  const all = [
    { name: "read", description: "x" }, { name: "capability_search", description: "x" },
    { name: "kb_search", description: "search docs" }, { name: "kb_open", description: "open a doc" },
  ];
  const caps = harvestTools(all);
  const ids = caps.map((c) => c.id);
  expect(ids).toEqual(["tool:pi:kb_search", "tool:pi:kb_open"]);
  expect(ALWAYS_ACTIVE.has("read")).toBe(true);
  expect(ALWAYS_ACTIVE.has("capability_search")).toBe(true);
});

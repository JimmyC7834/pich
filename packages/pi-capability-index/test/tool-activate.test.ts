import { test, expect } from "vitest";
import { buildCapContext } from "../src/cap-context.js";
import { upsertCapability } from "../src/index-store.js";
import { makeCapabilityActivate } from "../src/tools/capability_activate.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-ta-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}

test("activating a skill returns content/path to apply now and marks it session-active", async () => {
  const c = ctx();
  upsertCapability(c.db, { id: "skill:demo", kind: "skill", source: "/s", name: "demo", summary: "d",
    searchText: { name: "demo", summary: "d", params: "" }, activation: { filePath: "/s/demo/SKILL.md" } });
  const tool = makeCapabilityActivate(c);
  const out = await tool.execute("1", { id: "skill:demo" });
  // file doesn't exist here -> falls back to the read-now-and-apply instruction
  expect(out.content[0].text).toContain("/s/demo/SKILL.md");
  expect(out.content[0].text).toMatch(/apply it now|read .* now and apply/);
  expect((out.details as any).available).toBe("now");
  expect(c.sessionActive.has("skill:demo")).toBe(true);
});

test("unknown id returns an error payload, not a throw", async () => {
  const c = ctx();
  const tool = makeCapabilityActivate(c);
  const out = await tool.execute("1", { id: "skill:missing" });
  expect(out.content[0].text).toContain("not found");
});

test("activating a tool capability enables it and returns its spec to use now", async () => {
  const c = ctx();
  let active = ["read"];
  c.tools = { getActive: () => active, setActive: (n) => { active = n; } };
  upsertCapability(c.db, { id: "tool:pi:kb_search", kind: "tool", source: "pi", name: "kb_search",
    summary: "search docs", searchText: { name: "kb_search", summary: "search docs", params: "query:string" },
    activation: { toolName: "kb_search" } });
  const out = await makeCapabilityActivate(c).execute("1", { id: "tool:pi:kb_search" });
  const text = out.content[0].text;
  expect(text).toContain("kb_search");
  expect(text).toContain("now active");
  expect(text).toContain("search docs");       // description
  expect(text).toContain("query:string");       // param spec
  expect((out.details as any).available).toBe("now");
  expect(active).toContain("kb_search");
});

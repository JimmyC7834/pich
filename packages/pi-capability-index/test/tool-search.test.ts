import { test, expect } from "vitest";
import { buildCapContext } from "../src/cap-context.js";
import { upsertCapability } from "../src/index-store.js";
import { makeCapabilitySearch } from "../src/tools/capability_search.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-ts-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}

test("tool returns compact ranked lines filtered by kind", async () => {
  const c = ctx();
  upsertCapability(c.db, { id: "skill:deploy", kind: "skill", source: "/s", name: "deploy",
    summary: "deploy the app", searchText: { name: "deploy", summary: "deploy the app", params: "" }, activation: {} });
  const tool = makeCapabilitySearch(c);
  const out = await tool.execute("1", { query: "deploy", kind: "skill" });
  const text = out.content[0].text;
  // lossless line format: "<score>  skill:deploy — deploy the app"
  expect(text).toContain("skill:deploy — deploy the app");
  expect(text).toMatch(/^\d+ hits \(\w+ confidence\)/);
  // structured data still available to programmatic/UI consumers via details
  expect((out.details as any).hits[0].id).toBe("skill:deploy");
});

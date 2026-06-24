import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";
import { buildCapContext } from "../src/cap-context.js";
import { harvestTools } from "../src/harvest/tools.js";
import { upsertCapability, allIds } from "../src/index-store.js";
import { capabilitySearch } from "../src/search.js";
import { makeCapabilityActivate } from "../src/tools/capability_activate.js";

test("harvested tools are searchable by kind:tool and activatable via ctx.tools", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "cap-e2etools-"));
  const ctx = buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
  let active = ["read", "capability_search"];
  ctx.tools = { getActive: () => active, setActive: (n) => { active = n; } };

  for (const c of harvestTools([
    { name: "read", description: "builtin" },
    { name: "kb_search", description: "search the library" },
    { name: "kb_open", description: "open a document" },
  ])) upsertCapability(ctx.db, c);

  expect(allIds(ctx.db)).toEqual(expect.arrayContaining(["tool:pi:kb_search", "tool:pi:kb_open"]));
  const found = capabilitySearch(ctx.db, "search library", { kind: "tool" });
  expect(found.hits[0].id).toBe("tool:pi:kb_search");

  await makeCapabilityActivate(ctx).execute("1", { id: "tool:pi:kb_search" });
  expect(active).toContain("kb_search");
});

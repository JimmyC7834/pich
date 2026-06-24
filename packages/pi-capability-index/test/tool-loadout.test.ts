import { test, expect } from "vitest";
import { buildCapContext } from "../src/cap-context.js";
import { makeLoadout } from "../src/tools/loadout.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-lo-tool-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}

test("create, add, activate, list via the tool", async () => {
  const c = ctx();
  const tool = makeLoadout(c);
  await tool.execute("1", { action: "create", name: "frontend", description: "ui" });
  await tool.execute("2", { action: "add", name: "frontend", capability: "skill:css" });
  await tool.execute("3", { action: "activate", name: "frontend" });
  const out = await tool.execute("4", { action: "list" });
  const parsed = JSON.parse(out.content[0].text);
  expect(parsed.active).toBe("frontend");
  expect(parsed.loadouts.find((l: any) => l.name === "frontend").skills).toContain("skill:css");
});

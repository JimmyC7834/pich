import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";
import { buildCapContext } from "../src/cap-context.js";
import { upsertCapability } from "../src/index-store.js";
import { makeCapabilityStatus } from "../src/tools/capability_status.js";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-status-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}
function skill(id: string, name: string) {
  return { id, kind: "skill" as const, source: "/s", name, summary: name,
    searchText: { name, summary: name, params: "" }, activation: { filePath: `/s/${name}/SKILL.md` } };
}

test("status reports indexed counts and the exact slim-block set (loadout only)", async () => {
  const c = ctx();
  upsertCapability(c.db, skill("skill:a", "a"));
  upsertCapability(c.db, skill("skill:b", "b"));
  upsertCapability(c.db, skill("skill:c", "c"));
  c.loadouts.createLoadout("only-b", { skills: ["skill:b"] });
  c.loadouts.setActive("only-b");

  const out = JSON.parse((await makeCapabilityStatus(c).execute()).content[0].text);
  expect(out.indexed.skill).toBe(3);
  expect(out.activeLoadout).toBe("only-b");
  // ground truth: the slim block shows ONLY the loadout's skill, not all 3
  expect(out.slimBlockWillShow).toEqual(["b"]);
});

test("session-activated skills join the slim-block set", async () => {
  const c = ctx();
  upsertCapability(c.db, skill("skill:a", "a"));
  upsertCapability(c.db, skill("skill:b", "b"));
  c.loadouts.createLoadout("only-b", { skills: ["skill:b"] });
  c.loadouts.setActive("only-b");
  c.sessionActive.add("skill:a"); // simulate capability_activate

  const out = JSON.parse((await makeCapabilityStatus(c).execute()).content[0].text);
  expect(out.slimBlockWillShow.sort()).toEqual(["a", "b"]);
});

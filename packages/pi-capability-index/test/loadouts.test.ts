import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LoadoutService } from "../src/loadouts.js";

function svc() {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-lo-"));
  return new LoadoutService(path.join(dir, "loadouts.yaml"));
}

test("CRUD lifecycle + active pointer + granular add/remove", () => {
  const s = svc();
  s.createLoadout("frontend", { description: "ui", skills: ["skill:frontend-design"] });
  expect(s.listLoadouts().map((l) => l.name)).toContain("frontend");
  s.addCapability("frontend", "skill:css");
  expect(s.getLoadout("frontend")!.skills).toContain("skill:css");
  s.removeCapability("frontend", "skill:css");
  expect(s.getLoadout("frontend")!.skills).not.toContain("skill:css");
  s.setActive("frontend");
  expect(s.getActive()).toBe("frontend");
  s.updateLoadout("frontend", { description: "ui work" });
  expect(s.getLoadout("frontend")!.description).toBe("ui work");
  s.deleteLoadout("frontend");
  expect(s.getLoadout("frontend")).toBeNull();
});

test("getActiveSkillIds returns core ∪ active loadout skills", () => {
  const s = svc();
  s.setCore(["skill:debugging"]);
  s.createLoadout("base", { skills: ["skill:brainstorming"] });
  s.setActive("base");
  const ids = s.getActiveSkillIds();
  expect(ids).toContain("skill:debugging");
  expect(ids).toContain("skill:brainstorming");
});

test("validate flags ids not present in a provided known-set (drift)", () => {
  const s = svc();
  s.createLoadout("base", { skills: ["skill:gone", "skill:here"] });
  const missing = s.validate("base", new Set(["skill:here"]));
  expect(missing).toEqual(["skill:gone"]);
});

test("getActiveToolIds returns core ∪ active loadout tools, filtered to tool:", () => {
  const s = svc();
  s.createLoadout("dev", { tools: ["tool:pi:kb_search"], skills: ["skill:x"] });
  s.setActive("dev");
  const ids = s.getActiveToolIds();
  expect(ids).toContain("tool:pi:kb_search");
  expect(ids).not.toContain("skill:x");
});

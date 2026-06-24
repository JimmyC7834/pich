import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoadoutGateway } from "../loadoutGateway.js";

function tmpFile() { return join(mkdtempSync(join(tmpdir(), "lg-")), "loadouts.yaml"); }

test("absent file yields empty snapshot with active=base", () => {
  const g = new LoadoutGateway(tmpFile());
  expect(g.snapshot()).toEqual({ loadouts: [], active: "base" });
});

test("create/update/addCap/removeCap/setActive round-trip", () => {
  const g = new LoadoutGateway(tmpFile());
  g.create("dev", { description: "dev set" });
  g.addCap("dev", "skill:brainstorming");
  g.addCap("dev", "tool:pi:read");
  g.addCap("dev", "mcp:foo");
  g.setActive("dev");
  const snap = g.snapshot();
  expect(snap.active).toBe("dev");
  const dev = snap.loadouts.find((l) => l.name === "dev")!;
  expect(dev.skills).toEqual(["skill:brainstorming"]);
  expect(dev.tools).toEqual(["tool:pi:read"]);
  expect(dev.mcp).toEqual(["mcp:foo"]);
  g.removeCap("dev", "tool:pi:read");
  expect(g.get("dev")!.tools).toEqual([]);
  g.remove("dev");
  expect(g.get("dev")).toBeNull();
});

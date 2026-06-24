import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { upsertCapability } from "../src/index-store.js";
import { capabilitySearch } from "../src/search.js";
import type { Capability } from "../src/types.js";

function cap(id: string, kind: any, name: string, summary: string, params = ""): Capability {
  return { id, kind, source: "/s", name, summary, searchText: { name, summary, params }, activation: {} };
}

test("name match outranks param-only match; results carry id/kind/name", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:screenshot", "skill", "screenshot", "capture page"));
  upsertCapability(db, cap("mcp:nav", "mcp", "navigate", "go to url", "screenshot: bool"));
  const res = capabilitySearch(db, "screenshot", {});
  expect(res.hits[0].id).toBe("skill:screenshot");
  expect(["high", "medium", "low"]).toContain(res.confidence);
});

test("kind filter restricts the set", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:a", "skill", "deploy", "deploy the app"));
  upsertCapability(db, cap("mcp:b", "mcp", "deploy", "deploy via api"));
  const onlyMcp = capabilitySearch(db, "deploy", { kind: "mcp" });
  expect(onlyMcp.hits.every((h) => h.kind === "mcp")).toBe(true);
  expect(onlyMcp.hits.length).toBe(1);
});

test("no match -> empty hits, low confidence", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:a", "skill", "alpha", "unrelated"));
  const res = capabilitySearch(db, "zzzznotacword", {});
  expect(res.hits.length).toBe(0);
  expect(res.confidence).toBe("low");
});

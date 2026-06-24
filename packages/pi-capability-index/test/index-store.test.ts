import { test, expect } from "vitest";
import { openDb } from "../src/db.js";
import { upsertCapability, getCapability, getCapabilities, deleteCapability, allIds } from "../src/index-store.js";
import type { Capability } from "../src/types.js";

function cap(id: string, name: string, summary = "", params = ""): Capability {
  return { id, kind: "skill", source: "/s", name, summary,
    searchText: { name, summary, params }, activation: { filePath: "/s/" + name } };
}

test("upsert inserts then updates idempotently; fts stays in sync", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:a", "alpha", "first"));
  upsertCapability(db, cap("skill:a", "alpha", "second")); // update, not duplicate
  const got = getCapability(db, "skill:a");
  expect(got?.summary).toBe("second");
  const ftsCount = db.prepare("SELECT count(*) n FROM capability_fts WHERE id=?").get("skill:a") as { n: number };
  expect(ftsCount.n).toBe(1); // no orphaned fts rows
});

test("searchText.params round-trips through store (lossless read)", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("tool:x", "x", "does x", "sheet_id: the id (enum: a|b)"));
  const got = getCapability(db, "tool:x");
  expect(got?.searchText.params).toBe("sheet_id: the id (enum: a|b)");
});

test("getCapabilities returns many; delete removes from both tables", () => {
  const db = openDb(":memory:");
  upsertCapability(db, cap("skill:a", "alpha"));
  upsertCapability(db, cap("skill:b", "beta"));
  expect(getCapabilities(db, ["skill:a", "skill:b"]).length).toBe(2);
  deleteCapability(db, "skill:a");
  expect(getCapability(db, "skill:a")).toBeNull();
  expect((db.prepare("SELECT count(*) n FROM capability_fts WHERE id=?").get("skill:a") as any).n).toBe(0);
  expect(allIds(db)).toEqual(["skill:b"]);
});

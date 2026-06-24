import { test, expect } from "vitest";
import { openDb } from "../src/db.js";

test("FTS5 weighted multi-column bm25 ranks name-matches above param-matches", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO capability_fts(id,name,summary,params) VALUES (?,?,?,?)")
    .run("a", "screenshot", "capture the page", "");
  db.prepare("INSERT INTO capability_fts(id,name,summary,params) VALUES (?,?,?,?)")
    .run("b", "navigate", "go to a url", "screenshot: optional bool");
  const rows = db.prepare(
    "SELECT id, bm25(capability_fts, 0.0, 8.0, 4.0, 1.0) AS bm FROM capability_fts WHERE capability_fts MATCH ? ORDER BY bm"
  ).all('"screenshot"') as { id: string; bm: number }[];
  expect(rows[0].id).toBe("a"); // name hit (weight 8) beats params hit (weight 1)
});

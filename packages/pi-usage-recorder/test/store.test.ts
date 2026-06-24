import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRow, readRows } from "../src/store.js";
import type { UsageRow } from "../src/row.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-")), "usage.jsonl");

const row = (turnIndex: number): UsageRow => ({
  sessionId: "s", turnIndex, ts: "t", model: "m",
  input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 4,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ctxTokens: 1, ctxWindow: 2, ctxPercent: 50,
});

test("missing file reads as empty", () => {
  expect(readRows(path.join(os.tmpdir(), "does-not-exist-xyz.jsonl"))).toEqual([]);
});

test("append then read round-trips, creating the dir", () => {
  const f = tmp();
  appendRow(f, row(0));
  appendRow(f, row(1));
  const rows = readRows(f);
  expect(rows.map((r) => r.turnIndex)).toEqual([0, 1]);
});

test("malformed lines are skipped", () => {
  const f = tmp();
  appendRow(f, row(0));
  fs.appendFileSync(f, "{ not json\n");
  appendRow(f, row(1));
  expect(readRows(f).map((r) => r.turnIndex)).toEqual([0, 1]);
});

import { test, expect } from "vitest";
import { summarize, ctxPercentSeries } from "../src/summary.js";
import type { UsageRow } from "../src/row.js";

const mk = (over: Partial<UsageRow>): UsageRow => ({
  sessionId: "s", turnIndex: 0, ts: "t", model: "m",
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ctxTokens: null, ctxWindow: null, ctxPercent: null, ...over,
});

test("empty rows → zeroed summary, ratio 0", () => {
  const s = summarize([]);
  expect(s.turns).toBe(0);
  expect(s.cacheHitRatio).toBe(0);
  expect(s.ctx.last).toBeNull();
});

test("totals, sessions, and cache-hit ratio", () => {
  const s = summarize([
    mk({ sessionId: "a", input: 100, cacheRead: 800, cacheWrite: 100, totalTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } }),
    mk({ sessionId: "b", input: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } }),
  ]);
  expect(s.turns).toBe(2);
  expect(s.sessions).toBe(2);
  expect(s.totals.cacheRead).toBe(800);
  expect(s.totals.cost).toBeCloseTo(0.6);
  // cacheRead / (input + cacheRead + cacheWrite) = 800 / (200 + 800 + 100)
  expect(s.cacheHitRatio).toBeCloseTo(800 / 1100);
});

test("context first/last/max tracked, nulls ignored", () => {
  const s = summarize([
    mk({ ctxTokens: 1000, ctxWindow: 200000, ctxPercent: 0.5 }),
    mk({ ctxTokens: null, ctxPercent: null }),
    mk({ ctxTokens: 5000, ctxWindow: 200000, ctxPercent: 2.5 }),
  ]);
  expect(s.ctx.first).toBe(1000);
  expect(s.ctx.last).toBe(5000);
  expect(s.ctx.max).toBe(5000);
  expect(s.ctx.window).toBe(200000);
});

test("ctxPercentSeries drops null percents", () => {
  expect(ctxPercentSeries([mk({ ctxPercent: 1 }), mk({ ctxPercent: null }), mk({ ctxPercent: 3 })])).toEqual([1, 3]);
});

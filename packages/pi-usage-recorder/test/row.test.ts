import { test, expect } from "vitest";
import { usageRowFromEvent } from "../src/row.js";

const usage = {
  input: 100, output: 50, cacheRead: 4000, cacheWrite: 200, totalTokens: 4350,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.05, total: 0.36 },
};
const ctx = { tokens: 4200, contextWindow: 200000, percent: 2.1 };

test("builds a row from an assistant turn", () => {
  const row = usageRowFromEvent("s1", 3, { role: "assistant", model: "claude-opus-4-8", usage }, ctx, "2026-06-13T00:00:00Z");
  expect(row).toMatchObject({
    sessionId: "s1", turnIndex: 3, model: "claude-opus-4-8",
    input: 100, output: 50, cacheRead: 4000, cacheWrite: 200, totalTokens: 4350,
    ctxTokens: 4200, ctxWindow: 200000, ctxPercent: 2.1,
  });
  expect(row!.cost.total).toBe(0.36);
});

test("returns null for non-assistant messages", () => {
  expect(usageRowFromEvent("s1", 1, { role: "user", content: "hi" } as any, ctx, "t")).toBeNull();
  expect(usageRowFromEvent("s1", 1, { role: "toolResult" } as any, ctx, "t")).toBeNull();
});

test("returns null for assistant without usage", () => {
  expect(usageRowFromEvent("s1", 1, { role: "assistant", model: "m" }, ctx, "t")).toBeNull();
});

test("tolerates missing context usage (null fields)", () => {
  const row = usageRowFromEvent("s1", 0, { role: "assistant", usage }, undefined, "t");
  expect(row!.ctxTokens).toBeNull();
  expect(row!.ctxWindow).toBeNull();
  expect(row!.ctxPercent).toBeNull();
  expect(row!.model).toBe("unknown");
});

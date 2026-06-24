import { test, expect } from "vitest";
import { loopDecision, shouldCompact, type RunState } from "../src/loop.js";

const base = (over: Partial<RunState> = {}): RunState => ({
  active: true, project: "p", iterations: 0, max: 20, once: false, pendingContinue: true, ...over,
});

test("idle when run inactive", () => {
  expect(loopDecision(base({ active: false }), true)).toBe("idle");
});

test("idle when no task just completed (pendingContinue false)", () => {
  expect(loopDecision(base({ pendingContinue: false }), true)).toBe("idle");
});

test("once mode stops after a completion", () => {
  expect(loopDecision(base({ once: true }), true)).toBe("stop-once");
});

test("stops at max iterations", () => {
  expect(loopDecision(base({ iterations: 20, max: 20 }), true)).toBe("stop-max");
});

test("stops when the board is empty", () => {
  expect(loopDecision(base(), false)).toBe("stop-empty");
});

test("continues when active, pending, under max, and work remains", () => {
  expect(loopDecision(base({ iterations: 3 }), true)).toBe("continue");
});

test("shouldCompact: true at or above threshold", () => {
  expect(shouldCompact(70, 70)).toBe(true);
  expect(shouldCompact(85, 70)).toBe(true);
});

test("shouldCompact: false below threshold", () => {
  expect(shouldCompact(40, 70)).toBe(false);
  expect(shouldCompact(0, 70)).toBe(false);
});

test("shouldCompact: unknown usage compacts (safe default)", () => {
  expect(shouldCompact(null, 70)).toBe(true);
  expect(shouldCompact(undefined, 70)).toBe(true);
});

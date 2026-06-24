import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import {
  sembleDecision, setSembleDecision, plannedAction,
  enabledMarker, optOutMarker, warmSignal,
} from "../src/decision.js";

function tmpRepo(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "sem-dec-")); }

test("sembleDecision: unset when no cache dir", () => {
  const root = tmpRepo();
  expect(sembleDecision(root)).toBe("unset");
  fs.rmSync(root, { recursive: true, force: true });
});

test("sembleDecision: enabled marker -> enabled", () => {
  const root = tmpRepo();
  setSembleDecision(root, "enabled");
  expect(fs.existsSync(enabledMarker(root))).toBe(true);
  expect(sembleDecision(root)).toBe("enabled");
  fs.rmSync(root, { recursive: true, force: true });
});

test("sembleDecision: legacy .warm-signal counts as enabled", () => {
  const root = tmpRepo();
  fs.mkdirSync(path.dirname(warmSignal(root)), { recursive: true });
  fs.writeFileSync(warmSignal(root), "sig");
  expect(sembleDecision(root)).toBe("enabled");
  fs.rmSync(root, { recursive: true, force: true });
});

test("sembleDecision: opt-out marker -> disabled", () => {
  const root = tmpRepo();
  setSembleDecision(root, "disabled");
  expect(fs.existsSync(optOutMarker(root))).toBe(true);
  expect(sembleDecision(root)).toBe("disabled");
  fs.rmSync(root, { recursive: true, force: true });
});

test("sembleDecision: opt-out wins over enabled / warm-signal", () => {
  const root = tmpRepo();
  setSembleDecision(root, "enabled");
  fs.writeFileSync(warmSignal(root), "sig");
  fs.writeFileSync(optOutMarker(root), "1");
  expect(sembleDecision(root)).toBe("disabled");
  fs.rmSync(root, { recursive: true, force: true });
});

test("setSembleDecision flips cleanly between states", () => {
  const root = tmpRepo();
  setSembleDecision(root, "enabled");
  setSembleDecision(root, "disabled");
  expect(fs.existsSync(enabledMarker(root))).toBe(false);
  expect(sembleDecision(root)).toBe("disabled");
  setSembleDecision(root, "enabled");
  expect(fs.existsSync(optOutMarker(root))).toBe(false);
  expect(sembleDecision(root)).toBe("enabled");
  fs.rmSync(root, { recursive: true, force: true });
});

test("plannedAction matrix", () => {
  // enabled / disabled ignore UI + autoInit
  expect(plannedAction("enabled", false, false)).toBe("warm");
  expect(plannedAction("disabled", true, true)).toBe("skip");
  // unset: autoInit bypasses the prompt
  expect(plannedAction("unset", false, true)).toBe("auto-enable");
  expect(plannedAction("unset", true, true)).toBe("auto-enable");
  // unset: prompt only when UI is available
  expect(plannedAction("unset", true, false)).toBe("prompt");
  expect(plannedAction("unset", false, false)).toBe("skip");
});

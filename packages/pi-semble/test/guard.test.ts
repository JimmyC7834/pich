import { test, expect } from "vitest";
import { classifyDiscovery } from "../src/guard.js";

test("flags grep/find/ls discovery, ignores targeted reads and node_modules", () => {
  expect(classifyDiscovery("grep", { query: "authenticate" }).hit).toBe(true);
  expect(classifyDiscovery("bash", { command: "rg foo src" }).hit).toBe(true);
  expect(classifyDiscovery("bash", { command: "ls src" }).hit).toBe(true);
  expect(classifyDiscovery("find", { pattern: "*.ts" }).hit).toBe(true);
  // Targeted reads of a named path are deliberate, not discovery — never nudged.
  expect(classifyDiscovery("read", { path: "src/auth.ts" }).hit).toBe(false);
  expect(classifyDiscovery("read", { path: "node_modules/x/i.ts" }).hit).toBe(false);
  expect(classifyDiscovery("read", { path: "notes.txt" }).hit).toBe(false);
  expect(classifyDiscovery("bash", { command: "cat src/auth.ts" }).hit).toBe(false);
  expect(classifyDiscovery("bash", { command: "npm test" }).hit).toBe(false);
});

import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { projectCacheDir, globalCacheDir, hfHome } from "../src/paths.js";
import { detectTargets } from "../src/detect.js";

test("cache paths resolve under .pi", () => {
  expect(projectCacheDir("C:/p")).toBe(path.join("C:/p", ".pi", "semble"));
  expect(globalCacheDir()).toBe(path.join(os.homedir(), ".pi", "cache", "semble-global"));
  expect(hfHome()).toBe(path.join(os.homedir(), ".pi", "cache", "hf"));
});

test("detectTargets marks a manifest dir as code and finds project kb", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.mkdirSync(path.join(root, "kb"), { recursive: true });
  const t = detectTargets(root);
  expect(t.isCode).toBe(true);
  expect(t.projectKb).toBe(path.join(root, "kb"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("detectTargets marks an empty dir as non-code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "det2-"));
  expect(detectTargets(root).isCode).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("detectTargets finds source nested below the root (no root manifest/source)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "det3-"));
  const nested = path.join(root, "agent", "extensions");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "wire.ts"), "export const x = 1;\n");
  expect(detectTargets(root).isCode).toBe(true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("detectTargets ignores source buried only in node_modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "det4-"));
  const nm = path.join(root, "node_modules", "pkg");
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, "index.js"), "module.exports = 1;\n");
  expect(detectTargets(root).isCode).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});

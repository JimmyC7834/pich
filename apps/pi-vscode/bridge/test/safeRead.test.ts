import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeReadFile } from "../safeRead.js";

test("reads a file inside an allowed root", () => {
  const root = mkdtempSync(join(tmpdir(), "sr-"));
  const f = join(root, "skills", "a.md");
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(f, "# hi");
  const r = safeReadFile(f, [join(root, "skills")]);
  expect(r).toEqual({ ok: true, content: "# hi" });
});

test("rejects traversal outside the root", () => {
  const root = mkdtempSync(join(tmpdir(), "sr-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  const r = safeReadFile(join(root, "skills", "..", "secret.txt"), [join(root, "skills")]);
  expect(r.ok).toBe(false);
});

test("rejects a path under no allowed root", () => {
  const r = safeReadFile(join(tmpdir(), "nope.txt"), [join(tmpdir(), "skills")]);
  expect(r.ok).toBe(false);
});

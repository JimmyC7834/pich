import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCapContext } from "../src/cap-context.js";
import { capabilitySearch } from "../src/search.js";

test("buildCapContext opens db, writes gitignore, and refresh() indexes skills", () => {
  const home = mkdtempSync(path.join(tmpdir(), "cap-home-"));
  const sdir = path.join(home, "myskills", "demo"); mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, "SKILL.md"), "---\nname: demo\ndescription: indexed demo skill\n---\nbody\n");
  const ctx = buildCapContext({ homeDir: home, cwd: home, skillPaths: [path.join(home, "myskills", "demo")], includeDefaults: false });
  ctx.refresh();
  const res = capabilitySearch(ctx.db, "demo", { kind: "skill" });
  expect(res.hits.some((h) => h.id === "skill:demo")).toBe(true);
  expect(ctx.sessionActive.size).toBe(0);
});

test("refresh is cwd-INDEPENDENT: a skill under <cwd>/.pi/skills is NOT indexed", () => {
  // Guards the timeout/correctness fix: the global index must not scan the launch dir,
  // or a huge/symlinked <cwd>/.pi/skills would freeze the synchronous reindex.
  const home = mkdtempSync(path.join(tmpdir(), "cap-home2-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "cap-cwd-"));
  const cwdSkill = path.join(cwd, ".pi", "skills", "lurker"); mkdirSync(cwdSkill, { recursive: true });
  writeFileSync(path.join(cwdSkill, "SKILL.md"), "---\nname: lurker\ndescription: should not be indexed\n---\nx\n");
  const ctx = buildCapContext({ homeDir: home, cwd, skillPaths: [], includeDefaults: true });
  ctx.refresh();
  const res = capabilitySearch(ctx.db, "lurker", { kind: "skill" });
  expect(res.hits.some((h) => h.id === "skill:lurker")).toBe(false);
});

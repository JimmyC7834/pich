import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildCapContext } from "../src/cap-context.js";
import { makeCapabilityAdd } from "../src/tools/capability_add.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

function ctx() {
  const home = mkdtempSync(path.join(tmpdir(), "cap-add-"));
  return buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
}

test("creates a SKILL.md with frontmatter and indexes it", async () => {
  const c = ctx();
  const tool = makeCapabilityAdd(c);
  const out = await tool.execute("1", { name: "my-skill", description: "does a thing", body: "## Steps\nrun it" });
  const text = out.content[0].text;
  expect(text).toContain("my-skill");
  const dir = path.join(c.root, "..", "skills", "my-skill", "SKILL.md");
  expect(existsSync(dir)).toBe(true);
  expect(readFileSync(dir, "utf-8")).toContain("name: my-skill");
});

test("refuses content containing a secret", async () => {
  const c = ctx();
  const tool = makeCapabilityAdd(c);
  const out = await tool.execute("1", { name: "leaky", description: "x", body: "key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD" });
  expect(out.content[0].text.toLowerCase()).toContain("secret");
});

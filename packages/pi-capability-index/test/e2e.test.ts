import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import path from "node:path";
import { buildCapContext } from "../src/cap-context.js";
import { makeCapabilitySearch } from "../src/tools/capability_search.js";
import { makeCapabilityActivate } from "../src/tools/capability_activate.js";
import { slimSkillsBlock } from "../src/prompt-rewrite.js";
import { computeActiveIds } from "../src/promotion.js";
import { getCapabilities } from "../src/index-store.js";

test("harvest -> search -> activate -> next prompt includes the activated skill", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "cap-e2e-"));
  const sdir = path.join(home, "skills", "retry"); mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, "SKILL.md"), "---\nname: retry\ndescription: exponential backoff retries\n---\nbody\n");
  const ctx = buildCapContext({ homeDir: home, cwd: home, skillPaths: [sdir], includeDefaults: false });
  ctx.refresh();

  const found = await makeCapabilitySearch(ctx).execute("1", { query: "backoff" });
  expect((found.details as any).hits[0].id).toBe("skill:retry");
  expect(found.content[0].text).toContain("skill:retry —");

  await makeCapabilityActivate(ctx).execute("2", { id: "skill:retry" });
  expect(ctx.sessionActive.has("skill:retry")).toBe(true);

  const ids = computeActiveIds({ loadoutIds: [], sessionIds: ctx.sessionActive, db: ctx.db, ceiling: 5 });
  const skills = getCapabilities(ctx.db, ids);
  const prompt = slimSkillsBlock("x\n<available_skills>\n</available_skills>\ny", skills);
  expect(prompt).toContain("retry");
});

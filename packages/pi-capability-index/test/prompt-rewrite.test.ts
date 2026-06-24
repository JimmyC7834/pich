import { test, expect } from "vitest";
import { slimSkillsBlock } from "../src/prompt-rewrite.js";

const BLOCK = `intro text
<available_skills>
  <skill><name>alpha</name><description>A</description><location>/s/alpha/SKILL.md</location></skill>
  <skill><name>beta</name><description>B</description><location>/s/beta/SKILL.md</location></skill>
  <skill><name>gamma</name><description>C</description><location>/s/gamma/SKILL.md</location></skill>
</available_skills>
trailing text`;

test("replaces the block with only the provided skills + a search pointer", () => {
  const out = slimSkillsBlock(BLOCK, [
    { name: "beta", summary: "B", activation: { filePath: "/s/beta/SKILL.md" } } as any,
  ]);
  expect(out).toContain("intro text");
  expect(out).toContain("trailing text");
  expect(out).toContain("beta");
  expect(out).not.toContain("<name>alpha</name>");
  expect(out).not.toContain("<name>gamma</name>");
  expect(out).toContain("capability_search");
});

test("fail-open: no markers -> prompt returned unchanged", () => {
  const p = "a system prompt with no skills block at all";
  expect(slimSkillsBlock(p, [])).toBe(p);
});

test("empty active set still emits a valid (pointer-only) block", () => {
  const out = slimSkillsBlock(BLOCK, []);
  expect(out).toContain("capability_search");
  expect(out).not.toContain("<name>alpha</name>");
});

test("emits compact 'name: description' lines, no XML, path rule stated once", () => {
  const out = slimSkillsBlock(BLOCK, [
    { name: "alpha", summary: "A", activation: { filePath: "/s/alpha/SKILL.md" } } as any,
    { name: "beta", summary: "B", activation: { filePath: "/s/beta/SKILL.md" } } as any,
  ]);
  expect(out).not.toContain("<skill>");
  expect(out).not.toContain("<name>");
  expect(out).not.toContain("<description>");
  expect(out).not.toContain("<location>");
  expect(out).toContain("- alpha: A");
  expect(out).toContain("- beta: B");
  // shared path pattern stated once, not repeated per skill
  expect(out).toContain("/s/{name}/SKILL.md");
  expect(out).not.toContain("/s/alpha/SKILL.md");
});

test("collapses multi-line descriptions to a single line", () => {
  const out = slimSkillsBlock(BLOCK, [
    { name: "alpha", summary: "line one\n  line two", activation: { filePath: "/s/alpha/SKILL.md" } } as any,
  ]);
  expect(out).toContain("- alpha: line one line two");
});

test("non-uniform skill paths keep the path inline so files stay locatable", () => {
  const out = slimSkillsBlock("x<available_skills>old</available_skills>y", [
    { name: "alpha", summary: "A", activation: { filePath: "/a/alpha/SKILL.md" } } as any,
    { name: "beta", summary: "B", activation: { filePath: "/other/b.md" } } as any,
  ]);
  expect(out).not.toContain("<skill>");
  expect(out).toContain("/a/alpha/SKILL.md");
  expect(out).toContain("/other/b.md");
});

// fail-open hardening for malformed markers (load-bearing: runs every turn)
test("fail-open: only OPEN marker, no CLOSE -> unchanged", () => {
  const p = "intro\n<available_skills>\n  <skill>dangling</skill>\nno close";
  expect(slimSkillsBlock(p, [])).toBe(p);
});

test("fail-open: only CLOSE marker, no OPEN -> unchanged", () => {
  const p = "intro\n</available_skills>\nrest";
  expect(slimSkillsBlock(p, [])).toBe(p);
});

test("fail-open: CLOSE before OPEN -> unchanged", () => {
  const p = "a </available_skills> b <available_skills> c";
  expect(slimSkillsBlock(p, [])).toBe(p);
});

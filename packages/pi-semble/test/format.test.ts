import { test, expect } from "vitest";
import { formatHits } from "../src/format.js";

test("formatHits renders path:line, score, and authority when present", () => {
  const text = formatHits([
    { file_path: "a.ts", start_line: 3, end_line: 9, score: 0.51 } as any,
    { file_path: "b.md", start_line: 1, end_line: 2, score: 0.4, authority: "reference", sources: [{ url: "u" }] } as any,
  ]);
  expect(text).toContain("a.ts:3-9");
  expect(text).toContain("b.md:1-2");
  expect(text).toContain("reference");
});
test("formatHits handles empty", () => { expect(formatHits([])).toMatch(/no results/i); });

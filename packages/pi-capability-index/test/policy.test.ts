import { test, expect } from "vitest";
import { capPolicy } from "../src/policy.js";

test("compact policy names the search/activate tools; none is empty", () => {
  const p = capPolicy("compact");
  expect(p).toContain("capability_search");
  expect(p).toContain("capability_activate");
  expect(capPolicy("none")).toBe("");
});

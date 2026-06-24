import { test, expect } from "vitest";
import { computeActiveToolNames } from "../src/tool-deferral.js";

test("keeps non-deferrable tools always; deferrable only when wanted", () => {
  const keep = computeActiveToolNames({
    allToolNames: ["read", "capability_search", "kb_search", "kb_open", "kb_cite"],
    deferrableNames: new Set(["kb_search", "kb_open", "kb_cite"]),
    keepNames: new Set(["kb_search"]),
  });
  expect(keep).toContain("read");
  expect(keep).toContain("capability_search");
  expect(keep).toContain("kb_search");
  expect(keep).not.toContain("kb_open");
  expect(keep).not.toContain("kb_cite");
});

test("empty keepNames deactivates all deferrable tools but keeps the rest", () => {
  const keep = computeActiveToolNames({
    allToolNames: ["read", "kb_search", "kb_open"],
    deferrableNames: new Set(["kb_search", "kb_open"]),
    keepNames: new Set(),
  });
  expect(keep).toEqual(["read"]);
});

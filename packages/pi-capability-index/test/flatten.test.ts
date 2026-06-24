import { test, expect } from "vitest";
import { flattenParams } from "../src/flatten.js";

test("flattens JSON-schema params to a searchable string with names, descriptions, enums", () => {
  const schema = {
    type: "object",
    properties: {
      sheet_id: { type: "string", description: "the spreadsheet id" },
      mode: { type: "string", enum: ["read", "write"] },
    },
  };
  const out = flattenParams(schema);
  expect(out).toContain("sheet_id");
  expect(out).toContain("the spreadsheet id");
  expect(out).toContain("read");
  expect(out).toContain("write");
});

test("empty/invalid schema yields empty string", () => {
  expect(flattenParams(undefined)).toBe("");
  expect(flattenParams({})).toBe("");
});

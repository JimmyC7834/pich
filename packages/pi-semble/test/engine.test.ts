import { test, expect } from "vitest";
import path from "node:path";
import { buildSearchArgs, buildRelatedArgs, parseSembleJson, toIndexPath } from "../src/engine.js";

test("toIndexPath rewrites a forward-slash path to the OS-native separator", () => {
  expect(toIndexPath("agent/extensions/x/provenance.ts")).toBe(path.join("agent", "extensions", "x", "provenance.ts"));
});

test("buildSearchArgs produces a semble search invocation", () => {
  const args = buildSearchArgs("retry backoff", {
    repo: "C:/proj", cacheDir: "C:/proj/.pi/semble", content: "code", topK: 3, maxSnippetLines: 4,
  });
  expect(args.slice(0, 5)).toEqual(["--from", "semble[mcp]", "semble", "search", "retry backoff"]);
  expect(args).toContain("C:/proj");
  expect(args).toEqual(expect.arrayContaining(["--content", "code", "-k", "3", "--max-snippet-lines", "4"]));
});

test("buildRelatedArgs produces a find-related invocation", () => {
  const args = buildRelatedArgs("a.py", 12, { repo: "C:/proj", cacheDir: "C:/c", topK: 2, maxSnippetLines: 0 });
  expect(args.slice(0, 4)).toEqual(["--from", "semble[mcp]", "semble", "find-related"]);
  expect(args).toEqual(expect.arrayContaining(["a.py", "12", "C:/proj", "-k", "2", "--max-snippet-lines", "0"]));
});

test("parseSembleJson reads results and tolerates error/empty", () => {
  const hits = parseSembleJson('{"query":"q","results":[{"file_path":"a.ts","start_line":1,"end_line":9,"score":0.5,"content":"x"}]}');
  expect(hits).toHaveLength(1);
  expect(hits[0].file_path).toBe("a.ts");
  expect(parseSembleJson('{"error":"No results found."}')).toEqual([]);
  expect(parseSembleJson("garbage")).toEqual([]);
});

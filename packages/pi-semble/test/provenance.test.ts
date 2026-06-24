import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { buildSupersededSet, annotateKbHits, stripFrontmatter } from "../src/provenance.js";

test("stripFrontmatter removes a leading YAML block, leaves bodies untouched", () => {
  expect(stripFrontmatter("---\nid: d1\nauthority: reference\n---\n# Title\nbody")).toBe("# Title\nbody");
  expect(stripFrontmatter("## Section 2\nmid-document body")).toBe("## Section 2\nmid-document body");
});

function mkKb(): { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  fs.writeFileSync(path.join(dir, "v1.md"), `---\nid: backoff-v1\nauthority: agent-note\n---\nold backoff\n`);
  fs.writeFileSync(path.join(dir, "v2.md"), `---\nid: backoff-v2\nauthority: reference\nsupersedes: backoff-v1\nsources:\n  - url: https://x\n---\nnew backoff\n`);
  return { dir };
}

test("buildSupersededSet collects superseded ids", () => {
  const { dir } = mkKb();
  expect(buildSupersededSet([dir]).has("backoff-v1")).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("annotateKbHits drops superseded and annotates authority/sources", () => {
  const { dir } = mkKb();
  const superseded = buildSupersededSet([dir]);
  const hits = [
    { file_path: "v1.md", start_line: 1, end_line: 2, score: 0.9 },
    { file_path: "v2.md", start_line: 1, end_line: 2, score: 0.8 },
  ];
  const out = annotateKbHits(hits, dir, superseded);
  expect(out).toHaveLength(1);
  expect(out[0].doc_id).toBe("backoff-v2");
  expect(out[0].authority).toBe("reference");
  expect(out[0].sources[0].url).toBe("https://x");
  fs.rmSync(dir, { recursive: true, force: true });
});

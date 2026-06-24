import { test, expect, vi } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { scanSecrets } from "../src/secrets.js";
import { serializeDoc, readMeta } from "../src/frontmatter.js";
import { makeKbIngest } from "../src/tools/kb_ingest.js";

test("scanSecrets flags keys/tokens, passes prose", () => {
  expect(scanSecrets("token sk-ABCD1234EFGH5678IJKL9012MNOP").length).toBeGreaterThan(0);
  expect(scanSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").length).toBeGreaterThan(0);
  expect(scanSecrets("just normal prose about backoff")).toEqual([]);
});

test("serializeDoc round-trips through readMeta", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ser-"));
  const file = path.join(dir, "d.md");
  fs.writeFileSync(file, serializeDoc({ id: "d1", title: "T", authority: "reference", sources: [{ url: "u" }], supersedes: "old" }, "# T\nbody"));
  const m = readMeta(file);
  expect(m.id).toBe("d1");
  expect(m.authority).toBe("reference");
  expect(m.sources[0].url).toBe("u");
  expect(m.supersedes).toBe("old");
  fs.rmSync(dir, { recursive: true, force: true });
});

function ctxRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ing-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  return root;
}

test("kb_ingest writes a sourced doc with frontmatter (project scope)", async () => {
  const root = ctxRepo();
  const spy = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    const r = await makeKbIngest().execute("i", {
      title: "Backoff Notes", collection: "notes", scope: "project",
      body: "# Backoff\nexponential backoff with jitter", sources: [{ url: "https://x" }], authority: "reference",
    });
    expect(r.content[0].text).toMatch(/Ingested/);
    const docsDir = path.join(root, ".pi", "kb", "collections", "notes", "docs");
    const files = fs.readdirSync(docsDir);
    expect(files.length).toBe(1);
    const meta = readMeta(path.join(docsDir, files[0]));
    expect(meta.authority).toBe("reference");
    expect(meta.sources[0].url).toBe("https://x");
  } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("kb_ingest refuses missing sources and detected secrets", async () => {
  const root = ctxRepo();
  const spy = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    const noSrc = await makeKbIngest().execute("i", { title: "X", collection: "c", body: "hi", sources: [] });
    expect(noSrc.content[0].text.toLowerCase()).toContain("source");
    const secret = await makeKbIngest().execute("i", { title: "X", collection: "c", body: "key sk-ABCD1234EFGH5678IJKL9012MNOP", sources: [{ url: "u" }] });
    expect(secret.content[0].text.toLowerCase()).toContain("secret");
  } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

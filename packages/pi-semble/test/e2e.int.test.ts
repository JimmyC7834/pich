import { test, expect, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { makeCodeSearch } from "../src/tools/code_search.js";
import { makeKbSearch } from "../src/tools/kb_search.js";

function hasUvx(): boolean { try { execSync("uvx --version", { stdio: "ignore" }); return true; } catch { return false; } }
const maybe = hasUvx() ? test : test.skip;

maybe("code_search and kb_search return results end to end", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "semble-e2e-"));
  fs.writeFileSync(path.join(repo, "package.json"), "{}");
  fs.writeFileSync(path.join(repo, "retry.ts"), "export function exponentialBackoff(n:number){ return 2**n; }\n");
  const kb = path.join(repo, "kb"); fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, "doc.md"), `---\nid: d1\nauthority: reference\nsources:\n  - url: https://x\n---\n# Backoff\nexponential backoff with jitter\n`);
  const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
  try {
    const cs = await makeCodeSearch().execute("i", { query: "exponential backoff", top_k: 3 });
    expect(cs.content[0].text).toMatch(/retry\.ts/);
    const ks = await makeKbSearch().execute("i", { query: "backoff jitter", scope: "project", top_k: 3 });
    expect(ks.content[0].text).toMatch(/doc\.md/);
    expect(ks.content[0].text).toMatch(/reference/);
  } finally { spy.mockRestore(); fs.rmSync(repo, { recursive: true, force: true }); }
}, 180_000);

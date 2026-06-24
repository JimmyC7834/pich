import { test, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { sembleSearch } from "../src/engine.js";

function hasUvx(): boolean { try { execSync("uvx --version", { stdio: "ignore" }); return true; } catch { return false; } }
const maybe = hasUvx() ? test : test.skip;

maybe("sembleSearch indexes a temp repo and returns a relevant hit", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "semble-it-"));
  fs.writeFileSync(path.join(repo, "auth.ts"), "export function authenticateUser(token: string){ return verify(token); }\n");
  const cacheDir = path.join(repo, ".pi", "semble");
  const hits = await sembleSearch("authenticate a user with a token", {
    repo, cacheDir, content: "code", topK: 3, maxSnippetLines: 0,
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some(h => h.file_path.includes("auth.ts"))).toBe(true);
  fs.rmSync(repo, { recursive: true, force: true });
}, 120_000);

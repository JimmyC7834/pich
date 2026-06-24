import { test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRows } from "../src/store.js";

let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-wire-")), "usage.jsonl");
  process.env["USAGE_RECORDER_FILE"] = file;
  delete process.env["USAGE_RECORDER_DISABLE"];
});
afterEach(() => { delete process.env["USAGE_RECORDER_FILE"]; });

function makePi() {
  const handlers: Record<string, (e: any) => any> = {};
  const commands: string[] = [];
  const pi: any = {
    on: (e: string, h: (e: any, c: any) => any) => { handlers[e] = h; },
    registerCommand: (n: string) => commands.push(n),
  };
  // ExtensionContext (2nd handler arg) carries getContextUsage().
  const hctx = { getContextUsage: () => ({ tokens: 4200, contextWindow: 200000, percent: 2.1 }) };
  return { pi, handlers, commands, hctx };
}

test("registers session_start + turn_end + /usage", async () => {
  const mod = await import("../index.js");
  const { pi, handlers, commands } = makePi();
  mod.default(pi);
  expect(Object.keys(handlers)).toEqual(expect.arrayContaining(["session_start", "turn_end"]));
  expect(commands).toContain("usage");
});

test("an assistant turn_end appends exactly one row", async () => {
  const mod = await import("../index.js");
  const { pi, handlers, hctx } = makePi();
  mod.default(pi);
  await handlers["session_start"]!({}, hctx);
  await handlers["turn_end"]!({
    turnIndex: 5,
    message: { role: "assistant", model: "claude-opus-4-8", usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 10, totalTokens: 925, cost: { total: 0.01 } } },
  }, hctx);
  // a non-assistant turn writes nothing
  await handlers["turn_end"]!({ turnIndex: 6, message: { role: "user", content: "hi" } }, hctx);

  const rows = readRows(file);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ turnIndex: 5, input: 10, cacheRead: 900, ctxTokens: 4200, ctxPercent: 2.1 });
});

test("USAGE_RECORDER_DISABLE registers nothing", async () => {
  process.env["USAGE_RECORDER_DISABLE"] = "1";
  const mod = await import("../index.js");
  const { pi, handlers, commands } = makePi();
  mod.default(pi);
  expect(Object.keys(handlers)).toHaveLength(0);
  expect(commands).toHaveLength(0);
  delete process.env["USAGE_RECORDER_DISABLE"];
});

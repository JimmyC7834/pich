import { test, expect } from "vitest";
import { buildCapContext } from "../src/cap-context.js";
import { registerCommands } from "../src/commands.js";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path";

test("registers /loadout and /cap-reindex", () => {
  const home = mkdtempSync(path.join(tmpdir(), "cap-cmd-"));
  const ctx = buildCapContext({ homeDir: home, cwd: home, skillPaths: [], includeDefaults: false });
  const names: string[] = [];
  const pi: any = { registerCommand: (n: string) => names.push(n) };
  registerCommands(pi, ctx);
  expect(names).toContain("loadout");
  expect(names).toContain("cap-reindex");
});

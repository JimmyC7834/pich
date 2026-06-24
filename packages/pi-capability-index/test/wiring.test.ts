import { test, expect } from "vitest";
import extension from "../index.js";

test("default export registers tools, commands, and three hooks", () => {
  const tools: string[] = []; const commands: string[] = []; const events: string[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.push(t.name),
    registerCommand: (n: string) => commands.push(n),
    on: (e: string) => events.push(e),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  extension(pi);
  expect(tools).toEqual(expect.arrayContaining(["capability_search", "capability_activate", "capability_add", "loadout", "capability_status"]));
  expect(commands).toEqual(expect.arrayContaining(["loadout", "cap-reindex", "cap-status"]));
  expect(events).toEqual(expect.arrayContaining(["session_start", "tool_result", "before_agent_start"]));
});

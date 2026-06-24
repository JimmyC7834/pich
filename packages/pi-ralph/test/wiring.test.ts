import { test, expect, beforeEach } from "vitest";
import ralph from "../index.js";

function mockPi() {
  const tools: any[] = [];
  const commands: Record<string, any> = {};
  const hooks: Record<string, Function> = {};
  const sent: string[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.push(t),
    registerCommand: (n: string, c: any) => { commands[n] = c; },
    on: (e: string, h: Function) => { hooks[e] = h; },
    sendUserMessage: (m: string) => sent.push(m),
  };
  return { pi, tools, commands, hooks, sent };
}

function turnCtx(percent?: number | null) {
  const compacts: any[] = [];
  const c = {
    compact: (o: any) => { compacts.push(o); o.onComplete?.(); },
    getContextUsage: () => ({ tokens: null, contextWindow: 0, percent: percent ?? null }),
    ui: { notify: () => {} },
    hasUI: false,
  };
  return { c, compacts };
}

beforeEach(() => { process.env["RALPH_DB"] = ":memory:"; });

test("registers the six ralph tools and the commands", () => {
  const m = mockPi();
  ralph(m.pi);
  expect(m.tools.map((t) => t.name).sort()).toEqual(
    ["ralph_add", "ralph_claim", "ralph_complete", "ralph_list", "ralph_next", "ralph_progress"],
  );
  for (const cmd of ["ralph", "ralph-run", "ralph-add", "ralph-note"]) {
    expect(m.commands[cmd]).toBeDefined();
  }
});

test("/ralph-run activates the run and injects the kickoff prompt", async () => {
  const m = mockPi();
  ralph(m.pi);
  await m.commands["ralph-run"].handler("demo", { hasUI: false, ui: { notify: () => {} } });
  expect(m.sent.some((s) => s.includes("Ralph run for demo"))).toBe(true);
});

test("turn_end continues (compacts + injects) after a completion with work remaining", async () => {
  const m = mockPi();
  ralph(m.pi);
  // start a run + add tasks via the registered tools so they share `run`
  await m.commands["ralph-run"].handler("demo --max 5", { hasUI: false, ui: { notify: () => {} } });
  const add = m.tools.find((t) => t.name === "ralph_add");
  await add.execute("x", { project: "demo", title: "one", spec: "s" });
  await add.execute("y", { project: "demo", title: "two", spec: "s" });
  const complete = m.tools.find((t) => t.name === "ralph_complete");
  await complete.execute("z", { id: "one", summary: "done one" }); // arms pendingContinue

  const { c, compacts } = turnCtx(90);             // context high → compact
  await m.hooks["turn_end"]({}, c);
  expect(compacts).toHaveLength(1);                 // compacted after the task
  expect(m.sent.some((s) => s.includes("Continue"))).toBe(true);
});

test("turn_end continues WITHOUT compacting when context is under threshold", async () => {
  const m = mockPi();
  ralph(m.pi);
  await m.commands["ralph-run"].handler("demo --max 5", { hasUI: false, ui: { notify: () => {} } });
  const add = m.tools.find((t) => t.name === "ralph_add");
  await add.execute("x", { project: "demo", title: "one", spec: "s" });
  await add.execute("y", { project: "demo", title: "two", spec: "s" });
  const complete = m.tools.find((t) => t.name === "ralph_complete");
  await complete.execute("z", { id: "one", summary: "done one" });

  const { c, compacts } = turnCtx(5);              // context low → skip compaction
  await m.hooks["turn_end"]({}, c);
  expect(compacts).toHaveLength(0);                 // no compaction
  expect(m.sent.some((s) => s.includes("Continue"))).toBe(true); // but still continues
});

test("before_agent_start injects the board only while a run is active", async () => {
  const m = mockPi();
  ralph(m.pi);
  const before = m.hooks["before_agent_start"];
  expect(await before({ systemPrompt: "BASE" })).toBeUndefined();    // no run yet
  await m.commands["ralph-run"].handler("demo", { hasUI: false, ui: { notify: () => {} } });
  const r = await before({ systemPrompt: "BASE" });
  expect(r.systemPrompt).toContain("Ralph kanban — active run: demo");
});

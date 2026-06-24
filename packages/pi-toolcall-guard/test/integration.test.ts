import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index";

function makePi(toolNames: string[] = ["read", "edit", "write", "bash"]) {
	// Handlers are stored by event name with mixed arities: the real tool_call
	// handler takes (event, ctx) while tool_result takes (event) only. A variadic
	// type lets the harness invoke each with its true arity without TS2554.
	// getAllTools mirrors what the guard queries to gate nudges on tool
	// availability; the default set matches this harness (no grep/find tools).
	const handlers: Record<string, (...args: any[]) => any> = {};
	const pi = {
		registerTool: () => {},
		registerFlag: () => {},
		getFlag: () => false,
		on: (ev: string, h: (e: any, ctx: any) => any) => { handlers[ev] = h; },
		getAllTools: () => toolNames.map((name) => ({ name })),
	} as any;
	return { pi, handlers };
}

describe("guard integration", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "guard-int-"));
		process.env.PI_GUARD_DIR = join(dir, "metrics");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "utils.ts"), "");
	});
	afterEach(() => { delete process.env.PI_GUARD_DIR; try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

	it("blocks a nonexistent read path with a suggestion", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c1", input: { path: "src/util.ts" } },
			{ cwd: dir },
		);
		expect(res.block).toBe(true);
		expect(res.reason).toContain("src/utils.ts");
	});

	it("repairs a quoted path in place and proceeds", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		const input = { path: '"src/utils.ts"' };
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c2", input },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
		expect(input.path).toBe("src/utils.ts"); // mutated in place
	});

	it("passes an existing path untouched", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c3", input: { path: "src/utils.ts" } },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
	});

	it("enriches an error result and leaves success results alone", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		const err = handlers.tool_result({
			type: "tool_result", toolName: "read", toolCallId: "c4", input: {},
			isError: true, content: [{ type: "text", text: "ENOENT: no such file" }], details: undefined,
		});
		expect(err.content[0].text).toContain("[guard]");

		const ok = handlers.tool_result({
			type: "tool_result", toolName: "bash", toolCallId: "c5", input: {},
			isError: false, content: [{ type: "text", text: "fine" }], details: undefined,
		});
		expect(ok).toBeUndefined();
	});

	it("records a recovery when a blocked tool later succeeds", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		await handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c6", input: { path: "src/missing.ts" } },
			{ cwd: dir },
		);
		handlers.tool_result({
			type: "tool_result", toolName: "read", toolCallId: "c7", input: {},
			isError: false, content: [{ type: "text", text: "ok" }], details: undefined,
		});
		const log = readFileSync(join(dir, "metrics", ".pi-guard-metrics.jsonl"), "utf8");
		expect(log).toContain('"preflight_recovered"');
	});

	it("degrades to a no-op (no hooks) when the metrics dir cannot be created", async () => {
		const filePath = join(dir, "iamafile");
		writeFileSync(filePath, "x");
		process.env.PI_GUARD_DIR = join(filePath, "sub");
		const { pi, handlers } = makePi();
		expect(() => register(pi)).not.toThrow();
		expect(handlers.tool_call).toBeUndefined();
		expect(handlers.tool_result).toBeUndefined();
	});

	it("never throws out of tool_call even on a malformed event", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		// The handler is async and self-catching; awaiting must resolve, not reject.
		await handlers.tool_call(
			{ type: "tool_call", toolName: "read", toolCallId: "c8", input: null as any },
			{ cwd: dir },
		);
	});

	it("nudges a bash cat to the read tool and records it", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "n1", input: { command: "cat src/utils.ts" } },
			{ cwd: dir },
		);
		expect(res.block).toBe(true);
		expect(res.reason).toContain("read tool");
		const log = readFileSync(join(dir, "metrics", ".pi-guard-metrics.jsonl"), "utf8");
		expect(log).toContain('"nudge"');
	});

	it("passes a composed bash command untouched", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "n2", input: { command: "cat a.ts | head" } },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
	});

	it("passes an unrelated bash command untouched", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "n3", input: { command: "npm test" } },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
	});

	it("does not nudge bash grep when no grep tool is registered", async () => {
		const { pi, handlers } = makePi(); // default tool set has no grep tool
		register(pi);
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "n4", input: { command: "grep foo src/utils.ts" } },
			{ cwd: dir },
		);
		expect(res).toBeUndefined();
	});

	it("nudges bash grep when a grep tool IS registered", async () => {
		const { pi, handlers } = makePi(["read", "edit", "grep", "bash"]);
		register(pi);
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "n5", input: { command: "grep foo src/utils.ts" } },
			{ cwd: dir },
		);
		expect(res.block).toBe(true);
		expect(res.reason).toContain("grep tool");
	});

	it("blocks `git add -A` via a bundled rule and records a rule event", async () => {
		const { pi, handlers } = makePi();
		register(pi);
		const res = await handlers.tool_call(
			{ type: "tool_call", toolName: "bash", toolCallId: "r1", input: { command: "git add -A" } },
			{ cwd: dir },
		);
		expect(res.block).toBe(true);
		expect(res.reason).toContain("<system-interrupt");
		const log = readFileSync(join(dir, "metrics", ".pi-guard-metrics.jsonl"), "utf8");
		expect(log).toContain('"rule"');
		expect(log).toContain('"action":"block"');
	});

	it("prepends a reminder to a successful edit result for a project rule", async () => {
		// project rule (soft by default) lives in <cwd>/.pi/guard-rules
		mkdirSync(join(dir, ".pi", "guard-rules"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "guard-rules", "no-todo.md"),
			['---', 'condition: "TODO"', 'scope: "tool:edit"', '---', 'No TODOs in code.'].join("\n"),
		);
		writeFileSync(join(dir, "a.ts"), "x");
		const { pi, handlers } = makePi();
		register(pi);
		const call = await handlers.tool_call(
			{ type: "tool_call", toolName: "edit", toolCallId: "r2", input: { path: "a.ts", edits: [{ op: "replace", pos: "1#aa", lines: ["// TODO later"] }] } },
			{ cwd: dir },
		);
		expect(call).toBeUndefined(); // soft: not blocked
		const patch = handlers.tool_result({
			type: "tool_result", toolName: "edit", toolCallId: "r2", input: { path: "a.ts" },
			isError: false, content: [{ type: "text", text: "applied" }], details: undefined,
		});
		expect(patch.content[0].text).toContain("<system-reminder");
		expect(patch.content[1].text).toBe("applied");
	});

	it("does not prepend a reminder when the edit result is an error", async () => {
		mkdirSync(join(dir, ".pi", "guard-rules"), { recursive: true });
		writeFileSync(join(dir, ".pi", "guard-rules", "no-todo.md"), ['---', 'condition: "TODO"', 'scope: "tool:edit"', '---', 'No TODOs.'].join("\n"));
		writeFileSync(join(dir, "a.ts"), "x");
		const { pi, handlers } = makePi();
		register(pi);
		await handlers.tool_call(
			{ type: "tool_call", toolName: "edit", toolCallId: "r3", input: { path: "a.ts", edits: [{ op: "replace", pos: "1#aa", lines: ["// TODO"] }] } },
			{ cwd: dir },
		);
		const patch = handlers.tool_result({
			type: "tool_result", toolName: "edit", toolCallId: "r3", input: { path: "a.ts" },
			isError: true, content: [{ type: "text", text: "ENOENT" }], details: undefined,
		});
		// error path enriches; it must NOT carry a reminder block
		expect(patch?.content?.[0]?.text ?? "").not.toContain("<system-reminder");
	});

	it("aborts the stream and injects once when a prose rule matches", async () => {
		mkdirSync(join(dir, ".pi", "guard-rules"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "guard-rules", "no-refuse.md"),
			['---', 'condition: "I cannot help"', 'scope: "text"', 'interruptMode: always', '---', 'Attempt the task.'].join("\n"),
		);
		const aborts: number[] = [];
		const injected: string[] = [];
		const { pi, handlers } = makePi();
		// augment ctx with abort + ui; sendUserMessage capture
		pi.sendUserMessage = (content: any) => injected.push(String(content));
		register(pi);
		const ctx = { cwd: dir, hasUI: false, abort: () => aborts.push(1) };
		handlers.turn_start?.({ type: "turn_start" }, ctx);
		handlers.message_update(
			{ type: "message_update", message: { content: [{ type: "text", text: "sorry, I cannot help with that" }] } },
			ctx,
		);
		expect(aborts.length).toBe(1);
		expect(injected[0]).toContain("<system-reminder>[rule:no-refuse]");
		const log = readFileSync(join(dir, "metrics", ".pi-guard-metrics.jsonl"), "utf8");
		expect(log).toContain('"stream"');
	});

	it("does not fire the same prose rule twice in a session", async () => {
		mkdirSync(join(dir, ".pi", "guard-rules"), { recursive: true });
		writeFileSync(join(dir, ".pi", "guard-rules", "no-refuse.md"),
			['---', 'condition: "I cannot help"', 'scope: "text"', 'interruptMode: always', '---', 'Attempt it.'].join("\n"));
		let aborts = 0;
		const { pi, handlers } = makePi();
		pi.sendUserMessage = () => {};
		register(pi);
		const ctx = { cwd: dir, hasUI: false, abort: () => { aborts++; } };
		handlers.message_update({ type: "message_update", message: { content: [{ type: "text", text: "I cannot help" }] } }, ctx);
		handlers.turn_start?.({ type: "turn_start" }, ctx);
		handlers.message_update({ type: "message_update", message: { content: [{ type: "text", text: "I cannot help again" }] } }, ctx);
		expect(aborts).toBe(1);
	});

	it("does not register stream handlers when PI_GUARD_STREAM=0", async () => {
		process.env.PI_GUARD_STREAM = "0";
		try {
			const { pi, handlers } = makePi();
			register(pi);
			expect(handlers.message_update).toBeUndefined();
		} finally {
			delete process.env.PI_GUARD_STREAM;
		}
	});
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index";
import { parseHandle } from "../src/handle";

function harness() {
	const tools: Record<string, any> = {};
	let contextHandler: ((e: any) => any) | undefined;
	const pi = {
		registerTool: (t: any) => {
			tools[t.name] = t;
		},
		on: (event: string, handler: (e: any) => any) => {
			if (event === "context") contextHandler = handler;
		},
	} as any;
	return { pi, tools, fire: (messages: any[]) => contextHandler!({ type: "context", messages }) };
}

const toolResult = (toolName: string, text: string, isError = false) => ({
	role: "toolResult",
	toolName,
	toolCallId: "c1",
	isError,
	content: [{ type: "text", text }],
});
const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

describe("context-collapse extension", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "collapse-idx-"));
		process.env.PI_COLLAPSE_DIR = dir;
		process.env.PI_COLLAPSE_PROTECT_TOKENS = "0"; // make every result eligible in tests
	});
	afterEach(() => {
		delete process.env.PI_COLLAPSE_DIR;
		delete process.env.PI_COLLAPSE_PROTECT_TOKENS;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort: Windows holds the open SQLite handle for the session */
		}
	});

	it("registers the expand tool", () => {
		const h = harness();
		register(h.pi);
		expect(h.tools.expand).toBeDefined();
	});
	it("collapses an old big JSON bash result and embeds a handle", () => {
		const h = harness();
		register(h.pi);
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, n: i })));
		const out = h.fire([toolResult("bash", raw), userMsg("next")]);
		const text = out.messages[0].content[0].text;
		expect(parseHandle(text)?.type).toBe("json");
	});
	it("leaves error results untouched", () => {
		const h = harness();
		register(h.pi);
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ n: i })));
		const out = h.fire([toolResult("bash", raw, true), userMsg("next")]);
		expect(out.messages[0].content[0].text).toBe(raw);
	});
	it("protects the recent tail (does not collapse the newest result)", () => {
		const h = harness();
		register(h.pi);
		process.env.PI_COLLAPSE_PROTECT_TOKENS = "100000"; // protect everything
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ n: i })));
		const out = h.fire([toolResult("bash", raw)]);
		expect(out.messages[0].content[0].text).toBe(raw); // untouched while recent
	});
});

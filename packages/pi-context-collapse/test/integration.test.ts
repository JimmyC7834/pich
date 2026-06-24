import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../index";
import { parseHandle } from "../src/handle";

// Harness: capture registered hooks/tools. `ctx(messages)` fires the context
// hook (the lazy trimming pass). Protect window forced to 0 so every result is
// eligible, plus a recent tail so the candidate is past the (zero) window.
function setup() {
	const tools: Record<string, any> = {};
	const handlers: Record<string, (e?: any) => any> = {};
	const pi = {
		registerTool: (t: any) => {
			tools[t.name] = t;
		},
		on: (ev: string, h: (e: any) => any) => {
			handlers[ev] = h;
		},
	} as any;
	register(pi);
	const tr = (toolName: string, text: string) => ({
		role: "toolResult",
		toolName,
		isError: false,
		content: [{ type: "text", text }],
	});
	const ctx = (messages: any[]) => handlers.context?.({ type: "context", messages });
	return { tools, handlers, tr, ctx };
}
const tail = { role: "user", content: [{ type: "text", text: "x".repeat(8000) }] };

describe("collapse → expand round trip (via lazy context pass)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "collapse-int-"));
		process.env.PI_COLLAPSE_DIR = dir;
		process.env.PI_COLLAPSE_PROTECT_TOKENS = "0";
	});
	afterEach(() => {
		delete process.env.PI_COLLAPSE_DIR;
		delete process.env.PI_COLLAPSE_PROTECT_TOKENS;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* Windows holds the SQLite handle for the session; OS reclaims on exit */
		}
	});

	it("collapses an old result, then expand returns the exact raw original", async () => {
		const { tools, ctx } = setup();
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, n: i })));
		const out = ctx([{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: raw }] }, tail]);
		const collapsedText = out.messages[0].content[0].text;
		const handle = parseHandle(collapsedText);
		expect(handle).not.toBeNull();
		expect(collapsedText.length).toBeLessThan(raw.length);

		const expanded = await tools.expand.execute("id", { handle: `⟦${handle!.type}:${handle!.hash}⟧` });
		expect(expanded.content[0].text).toBe(raw);
	});

	it("never collapses results from the exempt expand tool", () => {
		const { ctx, tr } = setup();
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ n: i })));
		const out = ctx([tr("expand", raw), tail]);
		expect(out.messages[0].content[0].text).toBe(raw); // passed through
	});

	it("creates the metrics dir if it does not exist and registers the context hook", () => {
		const fresh = join(dir, "nested", "collapse");
		process.env.PI_COLLAPSE_DIR = fresh;
		expect(existsSync(fresh)).toBe(false);
		const { tools, handlers } = setup();
		expect(existsSync(fresh)).toBe(true);
		expect(tools.expand).toBeDefined();
		expect(handlers.context).toBeDefined();
	});

	it("degrades to a no-op (no throw, no tools) when the cache dir cannot be created", () => {
		const filePath = join(dir, "iamafile");
		writeFileSync(filePath, "x");
		process.env.PI_COLLAPSE_DIR = join(filePath, "sub");
		const { tools, handlers } = setup();
		expect(tools.expand).toBeUndefined();
		expect(handlers.context).toBeUndefined();
	});

	it("registers a session_shutdown handler that closes the cache without throwing", () => {
		const { handlers } = setup();
		expect(handlers.session_shutdown).toBeDefined();
		expect(() => handlers.session_shutdown!({})).not.toThrow();
	});
});

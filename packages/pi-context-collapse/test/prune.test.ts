import { describe, expect, it } from "vitest";
import { pruneMessages } from "../src/prune";
import { OriginalsCache } from "../src/cache";
import { parseHandle } from "../src/handle";

const bigJson = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, n: i })));
const tr = (toolName: string, text: string, isError = false) => ({
	role: "toolResult",
	toolName,
	isError,
	content: [{ type: "text", text }],
});
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

describe("pruneMessages (lazy cache-aware trimming)", () => {
	it("collapses an OLD tool result but protects the recent tail", () => {
		const cache = new OriginalsCache(":memory:");
		// old big result, then ~lots of recent tokens after it
		const tail = user("x".repeat(8000));
		const { messages, stats } = pruneMessages([tr("bash", bigJson), tail], cache, {
			protectTokens: 500,
		});
		expect(stats.trimmed).toBe(1);
		expect(parseHandle((messages[0] as any).content[0].text)?.type).toBe("json");
		expect(messages[1]).toBe(tail); // tail untouched
		cache.close();
	});
	it("does NOT collapse when the result is within the protected window", () => {
		const cache = new OriginalsCache(":memory:");
		const { messages, stats } = pruneMessages([tr("bash", bigJson)], cache, {
			protectTokens: 100000,
		});
		expect(stats.trimmed).toBe(0);
		expect((messages[0] as any).content[0].text).toBe(bigJson);
		cache.close();
	});
	it("never collapses error results", () => {
		const cache = new OriginalsCache(":memory:");
		const { stats } = pruneMessages([tr("bash", bigJson, true), user("x".repeat(8000))], cache, {
			protectTokens: 0,
		});
		expect(stats.trimmed).toBe(0);
		cache.close();
	});
	it("records each unique result once via the memo (idempotent across calls)", () => {
		const cache = new OriginalsCache(":memory:");
		const memo = new Map<string, string>();
		let trims = 0;
		const msgs = () => [tr("bash", bigJson), user("x".repeat(8000))];
		pruneMessages(msgs(), cache, { protectTokens: 500, memo, onTrim: () => trims++ });
		pruneMessages(msgs(), cache, { protectTokens: 500, memo, onTrim: () => trims++ });
		expect(trims).toBe(1); // second call hits the memo, no duplicate metric
		cache.close();
	});
	it("produces byte-identical output across calls (prompt-cache stable)", () => {
		const cache = new OriginalsCache(":memory:");
		const memo = new Map<string, string>();
		const a = pruneMessages([tr("bash", bigJson), user("x".repeat(8000))], cache, {
			protectTokens: 500,
			memo,
		});
		const b = pruneMessages([tr("bash", bigJson), user("x".repeat(8000))], cache, {
			protectTokens: 500,
			memo,
		});
		expect((a.messages[0] as any).content[0].text).toBe((b.messages[0] as any).content[0].text);
		cache.close();
	});
});

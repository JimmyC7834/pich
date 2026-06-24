import { describe, expect, it } from "vitest";
import { collapseText } from "../src/collapse";
import { OriginalsCache } from "../src/cache";
import { parseHandle } from "../src/handle";

describe("collapseText", () => {
	it("returns null for exempt tools (read/edit)", () => {
		const cache = new OriginalsCache(":memory:");
		const json = JSON.stringify({ a: Array.from({ length: 100 }, (_, i) => i) });
		expect(collapseText({ toolName: "read", text: json, cache })).toBeNull();
		cache.close();
	});
	it("collapses big JSON, embeds a handle, and caches the raw", () => {
		const cache = new OriginalsCache(":memory:");
		const raw = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, n: i })));
		const result = collapseText({ toolName: "bash", text: raw, cache, now: () => 123 });
		expect(result).not.toBeNull();
		const parsed = parseHandle(result!.collapsed);
		expect(parsed?.type).toBe("json");
		expect(cache.get(parsed!.hash)?.raw).toBe(raw);
		expect(cache.get(parsed!.hash)?.createdAt).toBe(123);
		cache.close();
	});
	it("returns null for content that does not classify (passes through)", () => {
		const cache = new OriginalsCache(":memory:");
		// 25 distinct lines: not JSON, low dup ratio, not a path list → classify returns null
		const text = Array.from({ length: 25 }, (_, i) => `unique line ${i} ${"x".repeat(40)}`).join("\n");
		expect(collapseText({ toolName: "bash", text, cache })).toBeNull();
		cache.close();
	});
});

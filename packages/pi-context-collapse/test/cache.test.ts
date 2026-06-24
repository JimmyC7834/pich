import { describe, expect, it } from "vitest";
import { OriginalsCache } from "../src/cache";

describe("OriginalsCache", () => {
	it("saves and retrieves a record by hash (in-memory)", () => {
		const cache = new OriginalsCache(":memory:");
		cache.save("h1", { raw: "RAW", toolName: "bash", type: "log", createdAt: 100 });
		expect(cache.get("h1")).toEqual({ raw: "RAW", toolName: "bash", type: "log", createdAt: 100 });
		cache.close();
	});
	it("returns undefined for a missing hash", () => {
		const cache = new OriginalsCache(":memory:");
		expect(cache.get("nope")).toBeUndefined();
		cache.close();
	});
	it("overwrites on duplicate hash", () => {
		const cache = new OriginalsCache(":memory:");
		cache.save("h1", { raw: "A", toolName: "bash", type: "json", createdAt: 1 });
		cache.save("h1", { raw: "B", toolName: "bash", type: "json", createdAt: 2 });
		expect(cache.get("h1")?.raw).toBe("B");
		cache.close();
	});
	it("evicts oldest entries beyond maxEntries, keeping the newest by insertion", () => {
		const cache = new OriginalsCache(":memory:", { maxEntries: 3 });
		for (let i = 1; i <= 5; i++) {
			cache.save(`h${i}`, { raw: `R${i}`, toolName: "bash", type: "json", createdAt: i });
		}
		expect(cache.size()).toBe(3);
		expect(cache.get("h1")).toBeUndefined();
		expect(cache.get("h2")).toBeUndefined();
		expect(cache.get("h3")?.raw).toBe("R3");
		expect(cache.get("h5")?.raw).toBe("R5");
		cache.close();
	});
	it("re-saving a hash refreshes its recency so it is not evicted", () => {
		const cache = new OriginalsCache(":memory:", { maxEntries: 2 });
		cache.save("a", { raw: "A", toolName: "bash", type: "json", createdAt: 1 });
		cache.save("b", { raw: "B", toolName: "bash", type: "json", createdAt: 2 });
		cache.save("a", { raw: "A2", toolName: "bash", type: "json", createdAt: 3 }); // refresh "a"
		cache.save("c", { raw: "C", toolName: "bash", type: "json", createdAt: 4 }); // should evict "b", not "a"
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")?.raw).toBe("A2");
		expect(cache.get("c")?.raw).toBe("C");
		cache.close();
	});
});

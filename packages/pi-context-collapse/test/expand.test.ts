import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExpandTool } from "../src/expand";
import { OriginalsCache } from "../src/cache";
import { Metrics } from "../src/metrics";
import { makeHandle } from "../src/handle";

function fakePi() {
	const tools: Record<string, any> = {};
	return {
		pi: { registerTool: (t: any) => { tools[t.name] = t; }, on: () => {} } as any,
		tools,
	};
}

describe("registerExpandTool", () => {
	it("returns the cached raw original for a handle", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collapse-expand-"));
		const cache = new OriginalsCache(":memory:");
		cache.save("abc123abc123", { raw: "THE RAW ORIGINAL", toolName: "bash", type: "json", createdAt: 1 });
		const { pi, tools } = fakePi();
		registerExpandTool(pi, cache, new Metrics(join(dir, "m.jsonl")));
		const res = await tools.expand.execute("id", { handle: makeHandle("json", "abc123abc123") });
		expect(res.content[0].text).toBe("THE RAW ORIGINAL");
		expect(res.isError).toBeFalsy();
		cache.close();
		rmSync(dir, { recursive: true, force: true });
	});
	it("errors when no original is cached", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collapse-expand-"));
		const cache = new OriginalsCache(":memory:");
		const { pi, tools } = fakePi();
		registerExpandTool(pi, cache, new Metrics(join(dir, "m.jsonl")));
		const res = await tools.expand.execute("id", { handle: "deadbeef0000" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("E_NO_ORIGINAL");
		cache.close();
		rmSync(dir, { recursive: true, force: true });
	});
	it("pages a large original via offset and reconstructs the full raw", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collapse-expand-"));
		const cache = new OriginalsCache(":memory:");
		const raw = "A".repeat(40000); // 40k chars > 16k limit
		const hash = "deadbeef123456"; // Valid hex hash (6+ hex chars)
		cache.save(hash, { raw, toolName: "bash", type: "json", createdAt: 1 });

		// Verify cache actually stored the value
		const rec = cache.get(hash);
		expect(rec).toBeDefined();
		expect(rec?.raw.length).toBe(40000);

		const { pi, tools } = fakePi();
		registerExpandTool(pi, cache, new Metrics(join(dir, "m.jsonl")));

		// First page: offset=0 (default)
		const page1 = await tools.expand.execute("id", { handle: makeHandle("json", hash) });
		expect(page1.isError).toBeFalsy();
		const page1Text = page1.content[0].text;
		expect(page1Text).toContain("Use offset=16000 to continue.");
		const page1Slice = page1Text.split("\n\n[Showing")[0]; // Strip the hint
		expect(page1Slice).toBe(raw.slice(0, 16000));

		// Second page: offset=16000
		const page2 = await tools.expand.execute("id", { handle: makeHandle("json", hash), offset: 16000 });
		expect(page2.isError).toBeFalsy();
		const page2Text = page2.content[0].text;
		expect(page2Text).toContain("Use offset=32000 to continue.");
		const page2Slice = page2Text.split("\n\n[Showing")[0];
		expect(page2Slice).toBe(raw.slice(16000, 32000));

		// Third page: offset=32000
		const page3 = await tools.expand.execute("id", { handle: makeHandle("json", hash), offset: 32000 });
		expect(page3.isError).toBeFalsy();
		const page3Text = page3.content[0].text;
		// No continuation hint on the last page
		expect(page3Text).not.toContain("Use offset");
		expect(page3Text).toBe(raw.slice(32000));

		// Reconstruct: concatenate all slices
		const reconstructed = page1Slice + page2Slice + page3Text;
		expect(reconstructed).toBe(raw);

		cache.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

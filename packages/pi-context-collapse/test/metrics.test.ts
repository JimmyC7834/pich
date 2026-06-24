import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Metrics } from "../src/metrics";

describe("Metrics", () => {
	it("appends one JSON line per event with a timestamp", () => {
		const dir = mkdtempSync(join(tmpdir(), "collapse-metrics-"));
		const path = join(dir, "m.jsonl");
		const metrics = new Metrics(path);
		metrics.record({ kind: "collapse", type: "json", toolName: "bash", rawTokens: 500, collapsedTokens: 50 });
		metrics.record({ kind: "expand", hash: "abc", type: "json", toolName: "bash" });
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!);
		expect(first.kind).toBe("collapse");
		expect(typeof first.ts).toBe("number");
		rmSync(dir, { recursive: true, force: true });
	});
});

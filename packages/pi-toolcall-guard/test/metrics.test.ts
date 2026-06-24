import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Metrics } from "../src/metrics";

describe("Metrics", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "guard-metrics-")); });
	afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

	it("appends one JSON line per event with a ts field", () => {
		const path = join(dir, "m.jsonl");
		const m = new Metrics(path);
		m.record({ kind: "preflight", outcome: "block", toolName: "read" });
		m.record({ kind: "enrich", matched: true, rule: "enoent", toolName: "bash" });
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]);
		expect(first.kind).toBe("preflight");
		expect(first.outcome).toBe("block");
		expect(typeof first.ts).toBe("number");
	});

	it("swallows IO errors (path under a nonexistent dir) without throwing", () => {
		const m = new Metrics(join(dir, "missing-subdir", "m.jsonl"));
		expect(() => m.record({ kind: "preflight_recovered", toolName: "read" })).not.toThrow();
		expect(existsSync(join(dir, "missing-subdir"))).toBe(false);
	});
});

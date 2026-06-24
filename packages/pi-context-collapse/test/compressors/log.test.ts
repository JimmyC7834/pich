import { describe, expect, it } from "vitest";
import { compressLog } from "../../src/compressors/log";

describe("compressLog", () => {
	it("dedupes identical lines with a count, keeping first-seen order", () => {
		const text = ["INFO start", "INFO tick", "INFO tick", "INFO tick", "INFO end"].join("\n");
		const out = compressLog(text);
		expect(out).toBe(["INFO start", "INFO tick  (×3)", "INFO end"].join("\n"));
	});
	it("preserves unique lines (e.g. errors) verbatim", () => {
		const text = ["INFO a", "INFO a", "ERROR boom at x.ts:42"].join("\n");
		expect(compressLog(text)).toContain("ERROR boom at x.ts:42");
	});
	it("strips ANSI escapes", () => {
		expect(compressLog("\x1b[32mPASS\x1b[0m test")).toBe("PASS test");
	});
	it("drops common build/shell noise lines", () => {
		const text = [
			"$ npm install",
			"npm warn deprecated foo@1.0.0",
			"added 412 packages in 3s",
			"[2/5] Fetching packages...",
			"Requirement already satisfied: urllib3",
			"DONE build ok",
		].join("\n");
		const out = compressLog(text);
		expect(out).toContain("$ npm install");
		expect(out).toContain("DONE build ok");
		expect(out).not.toContain("npm warn");
		expect(out).not.toContain("added 412 packages");
		expect(out).not.toContain("Requirement already satisfied");
	});
	it("keeps head+tail and elides the middle of long output, surfacing the tail error", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `step ${i}`);
		lines.push("ERROR final failure");
		const out = compressLog(lines.join("\n"));
		expect(out).toContain("step 0");
		expect(out).toContain("ERROR final failure");
		expect(out).toMatch(/lines elided/);
		expect(out.split("\n").length).toBeLessThan(100);
	});
});

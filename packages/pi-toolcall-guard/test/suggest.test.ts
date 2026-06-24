import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { levenshtein, nearMatches } from "../src/suggest";

describe("levenshtein", () => {
	it("is 0 for identical strings", () => { expect(levenshtein("abc", "abc")).toBe(0); });
	it("counts a single insertion", () => { expect(levenshtein("util", "utils")).toBe(1); });
	it("counts a single substitution", () => { expect(levenshtein("abc", "axc")).toBe(1); });
	it("counts transposed-length edits", () => { expect(levenshtein("kitten", "sitting")).toBe(3); });
	it("returns the other length when one string is empty", () => {
		expect(levenshtein("", "abc")).toBe(3);
		expect(levenshtein("abc", "")).toBe(3);
	});
});

describe("nearMatches", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "guard-suggest-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "utils.ts"), "");
		writeFileSync(join(dir, "src", "index.ts"), "");
	});
	afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

	it("suggests the closest sibling for a near-miss basename", () => {
		const out = nearMatches("src/util.ts", dir);
		expect(out).toContain("src/utils.ts");
	});

	it("ranks the closest match first", () => {
		const out = nearMatches("src/utild.ts", dir);
		expect(out[0]).toBe("src/utils.ts");
	});

	it("returns [] when the parent directory does not exist", () => {
		expect(nearMatches("nope/whatever.ts", dir)).toEqual([]);
	});

	it("returns [] when nothing is close enough", () => {
		expect(nearMatches("src/completely-different-name.ts", dir)).toEqual([]);
	});

	it("uses forward slashes regardless of platform", () => {
		const out = nearMatches("src/util.ts", dir);
		expect(out.every((p) => !p.includes("\\"))).toBe(true);
	});

	it("caps results at the max parameter", () => {
		// Three near-misses of "util.ts" so the threshold admits all of them.
		writeFileSync(join(dir, "src", "utils.ts"), "");
		writeFileSync(join(dir, "src", "util1.ts"), "");
		writeFileSync(join(dir, "src", "util2.ts"), "");
		expect(nearMatches("src/util.ts", dir, 2)).toHaveLength(2);
	});
});

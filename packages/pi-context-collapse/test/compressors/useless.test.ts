import { describe, expect, it } from "vitest";
import { isUseless, USELESS_NOTICE, compressUseless } from "../../src/compressors/useless";
import { classify } from "../../src/router";

describe("useless elision", () => {
	it("flags empty output from a search tool", () => {
		expect(isUseless("grep", "   \n  ")).toBe(true);
		expect(isUseless("code_search", "")).toBe(true);
	});
	it("flags a short no-matches verdict", () => {
		expect(isUseless("grep", "Searching for 'frobnicate'...\nNo matches found")).toBe(true);
	});
	it("does NOT flag empty bash output (success is not uselessness)", () => {
		expect(isUseless("bash", "")).toBe(false);
	});
	it("does NOT flag long output that merely mentions no matches", () => {
		const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\nno matches in file";
		expect(isUseless("grep", long)).toBe(false);
	});
	it("classify routes useless before the token gate", () => {
		expect(classify("grep", "No results")).toBe("useless");
	});
	it("compresses to the fixed notice", () => {
		expect(compressUseless("anything")).toBe(USELESS_NOTICE);
	});
});

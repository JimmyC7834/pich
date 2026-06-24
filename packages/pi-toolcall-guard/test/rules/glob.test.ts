import { describe, expect, it } from "vitest";
import { expandBraces, globToRegExp, matchGlob } from "../../src/rules/glob";

describe("expandBraces", () => {
	it("expands a single alternation", () => {
		expect(expandBraces("*.{ts,tsx}")).toEqual(["*.ts", "*.tsx"]);
	});

	it("expands nested alternations", () => {
		expect(expandBraces("*.{ts,tsx,js}").length).toBe(3);
		expect(expandBraces("a{1,2}b{3,4}")).toEqual(["a1b3", "a1b4", "a2b3", "a2b4"]);
	});

	it("returns the pattern unchanged when there is no brace", () => {
		expect(expandBraces("*.ts")).toEqual(["*.ts"]);
	});
});

describe("globToRegExp", () => {
	it("matches a basename star", () => {
		expect(globToRegExp("*.ts").test("foo.ts")).toBe(true);
		expect(globToRegExp("*.ts").test("foo.tsx")).toBe(false);
	});

	it("does not let a single star cross a slash", () => {
		expect(globToRegExp("*.ts").test("src/foo.ts")).toBe(false);
	});

	it("lets a double star cross slashes", () => {
		expect(globToRegExp("**/*.ts").test("src/a/foo.ts")).toBe(true);
	});
});

describe("matchGlob", () => {
	it("matches the basename fallback for a full path", () => {
		expect(matchGlob("*.ts", ["src/foo.ts"])).toBe(true);
	});

	it("matches brace alternations against paths", () => {
		expect(matchGlob("**/*.{ts,tsx}", ["packages/app/Button.tsx"])).toBe(true);
		expect(matchGlob("**/*.{ts,tsx}", ["packages/app/Button.css"])).toBe(false);
	});

	it("matches *.test.ts", () => {
		expect(matchGlob("*.test.ts", ["util.test.ts"])).toBe(true);
		expect(matchGlob("*.test.ts", ["util.ts"])).toBe(false);
	});

	it("returns false for empty path lists", () => {
		expect(matchGlob("*.ts", [])).toBe(false);
		expect(matchGlob("*.ts", undefined)).toBe(false);
	});
});

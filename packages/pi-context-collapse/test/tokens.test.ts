import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/tokens";

describe("estimateTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});
	it("estimates ~1 token per 4 chars, rounding up", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});

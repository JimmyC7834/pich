import { describe, it, expect } from "vitest";
import { resolveCompactModel, DEFAULT_COMPACT_MODEL } from "../src/model.js";

describe("resolveCompactModel", () => {
	it("parses a valid PI_AUTOCOMPACT_MODEL override", () => {
		expect(resolveCompactModel("anthropic/claude-haiku-4-5")).toEqual({
			provider: "anthropic",
			model: "claude-haiku-4-5",
		});
	});

	it("keeps everything after the first slash as the model id", () => {
		expect(resolveCompactModel("openrouter/meta/llama-3")).toEqual({
			provider: "openrouter",
			model: "meta/llama-3",
		});
	});

	it("falls back to the default when unset", () => {
		expect(resolveCompactModel(undefined)).toEqual(DEFAULT_COMPACT_MODEL);
	});

	it("ignores malformed values (no slash, empty sides, whitespace)", () => {
		for (const bad of ["", "   ", "deepseek", "/model", "provider/", "/"]) {
			expect(resolveCompactModel(bad)).toEqual(DEFAULT_COMPACT_MODEL);
		}
	});
});

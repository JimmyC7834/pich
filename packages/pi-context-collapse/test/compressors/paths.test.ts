import { describe, expect, it } from "vitest";
import { compressPaths } from "../../src/compressors/paths";

describe("compressPaths", () => {
	it("reports total count and clusters by top-level directory", () => {
		const paths = [
			...Array.from({ length: 30 }, (_, i) => `src/core/f${i}.ts`),
			...Array.from({ length: 10 }, (_, i) => `test/unit/t${i}.ts`),
		].join("\n");
		const out = compressPaths(paths);
		expect(out).toContain("40 paths");
		expect(out).toContain("src/core (30)");
		expect(out).toContain("test/unit (10)");
	});
	it("is shorter than input on large lists", () => {
		const paths = Array.from({ length: 100 }, (_, i) => `src/a/b/file${i}.ts`).join("\n");
		expect(compressPaths(paths).length).toBeLessThan(paths.length);
	});
});

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getPathArg, normalizePathValue, pathExists, PATH_TOOLS } from "../src/paths";

describe("getPathArg", () => {
	it("returns the 'path' arg for read", () => {
		expect(getPathArg("read", { path: "src/a.ts" })).toEqual({ key: "path", value: "src/a.ts" });
	});
	it("falls back to 'file_path' when 'path' is absent", () => {
		expect(getPathArg("edit", { file_path: "src/b.ts" })).toEqual({ key: "file_path", value: "src/b.ts" });
	});
	it("returns null for an unknown tool", () => {
		expect(getPathArg("expand", { path: "x" })).toBeNull();
	});
	it("returns null when the known tool has no string path arg (optional tools)", () => {
		expect(getPathArg("grep", { pattern: "foo" })).toBeNull();
	});
	it("ignores non-string path values", () => {
		expect(getPathArg("read", { path: 123 as unknown as string })).toBeNull();
	});
});

describe("normalizePathValue", () => {
	it("trims whitespace", () => {
		expect(normalizePathValue("  src/a.ts  ")).toBe("src/a.ts");
	});
	it("strips a single layer of matching double quotes", () => {
		expect(normalizePathValue('"src/a.ts"')).toBe("src/a.ts");
	});
	it("strips a single layer of matching single quotes", () => {
		expect(normalizePathValue("'src/a.ts'")).toBe("src/a.ts");
	});
	it("leaves an unquoted path unchanged", () => {
		expect(normalizePathValue("src/a.ts")).toBe("src/a.ts");
	});
	it("does not strip mismatched quotes", () => {
		expect(normalizePathValue("\"src/a.ts'")).toBe("\"src/a.ts'");
	});
});

describe("PATH_TOOLS", () => {
	it("marks write as a write tool and read as not", () => {
		expect(PATH_TOOLS.write.isWrite).toBe(true);
		expect(PATH_TOOLS.read.isWrite).toBe(false);
	});
	it("marks grep/find/ls path as optional", () => {
		expect(PATH_TOOLS.grep.optional).toBe(true);
		expect(PATH_TOOLS.read.optional).toBe(false);
	});
});

describe("pathExists", () => {
	const here = fileURLToPath(import.meta.url);
	it("returns true for an existing path", () => {
		expect(pathExists(here)).toBe(true);
	});
	it("returns false for a missing path", () => {
		expect(pathExists(join(here, "does-not-exist"))).toBe(false);
	});
});

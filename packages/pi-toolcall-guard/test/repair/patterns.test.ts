import { describe, test, expect } from "vitest";
import { PATTERNS } from "../../src/repair/patterns";

function bashSchema() {
	return {
		properties: {
			command: { type: "string" },
			timeout: { type: "number" },
			description: { type: "string" },
		} as Record<string, { type?: string }>,
		required: ["command"],
	};
}

// ── null-strip ──

test("null-strip: removes null on optional field", () => {
	const schema = bashSchema();
	const p = PATTERNS.find((x) => x.name === "null-strip")!;

	const matched = p.match("bash", "timeout", null, schema);
	expect(matched).toBe(true);
	expect(p.fix(null)).toBeUndefined(); // undefined → delete
});

test("null-strip: does NOT remove null on required field", () => {
	const schema = bashSchema();
	const p = PATTERNS.find((x) => x.name === "null-strip")!;

	const matched = p.match("bash", "command", null, schema);
	expect(matched).toBe(false);
});

// ── bool-string ──

test("bool-string: converts 'true' string to boolean true", () => {
	const schema = { properties: { overwrite: { type: "boolean" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "bool-string")!;

	expect(p.match("bash", "overwrite", "true", schema)).toBe(true);
	expect(p.fix("true")).toBe(true);
});

test("bool-string: converts 'false' string to boolean false", () => {
	const schema = { properties: { overwrite: { type: "boolean" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "bool-string")!;

	expect(p.match("bash", "overwrite", "false", schema)).toBe(true);
	expect(p.fix("false")).toBe(false);
});

test("bool-string: does NOT match on non-boolean field", () => {
	const schema = { properties: { command: { type: "string" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "bool-string")!;

	expect(p.match("bash", "command", "true", schema)).toBe(false);
});

// ── string-array ──

test("string-array: parses JSON stringified array", () => {
	const schema = { properties: { file_path: { type: "array" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "string-array")!;

	expect(p.match("read", "file_path", '["a.ts"]', schema)).toBe(true);
	expect(p.fix('["a.ts"]')).toEqual(["a.ts"]);
});

test("string-array: does NOT match on non-array field", () => {
	const schema = { properties: { file_path: { type: "string" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "string-array")!;

	expect(p.match("read", "file_path", '["a.ts"]', schema)).toBe(false);
});

test("string-array: does NOT match plain string", () => {
	const schema = { properties: { file_path: { type: "array" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "string-array")!;

	expect(p.match("read", "file_path", "hello", schema)).toBe(false);
});

// ── empty-object ──

test("empty-object: removes {} on scalar field", () => {
	const schema = { properties: { config: { type: "string" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "empty-object")!;

	expect(p.match("bash", "config", {}, schema)).toBe(true);
	expect(p.fix({})).toBeUndefined();
});

test("empty-object: does NOT match when schema expects object", () => {
	const schema = { properties: { config: { type: "object" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "empty-object")!;

	expect(p.match("bash", "config", {}, schema)).toBe(false);
});

test("empty-object: does NOT match non-empty object", () => {
	const schema = { properties: { config: { type: "string" } }, required: [] };
	const p = PATTERNS.find((x) => x.name === "empty-object")!;

	expect(p.match("bash", "config", { wat: 1 }, schema)).toBe(false);
});

// ── unknown-param ──

test("unknown-param: matches field not in schema", () => {
	const schema = { properties: { command: { type: "string" } }, required: ["command"] };
	const p = PATTERNS.find((x) => x.name === "unknown-param")!;

	expect(p.match("bash", "hallucinated", 42, schema)).toBe(true);
	expect(p.fix(42)).toBeUndefined();
});

test("unknown-param: does NOT match known field", () => {
	const schema = { properties: { command: { type: "string" } }, required: ["command"] };
	const p = PATTERNS.find((x) => x.name === "unknown-param")!;

	expect(p.match("bash", "command", "ls", schema)).toBe(false);
});

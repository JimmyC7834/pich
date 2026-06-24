import { describe, test, expect } from "vitest";
import { repairInput } from "../../src/repair/index";

const mockTools = [
	{
		name: "bash",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command" },
				timeout: { type: "number", description: "Timeout seconds" },
				description: { type: "string", description: "Optional note" },
				overwrite: { type: "boolean" },
			},
			required: ["command"],
		},
	},
	{
		name: "read",
		parameters: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "File path" },
				offset: { type: "number" },
				limit: { type: "number" },
			},
			required: ["file_path"],
		},
	},
];

test("null-strip: removes null on optional field", () => {
	const input: Record<string, unknown> = { command: "ls", timeout: null };
	const result = repairInput("bash", input, mockTools);

	expect(result.repairs).toHaveLength(1);
	expect(result.repairs[0]).toEqual({ pattern: "null-strip", field: "timeout" });
	expect(result.input.timeout).toBeUndefined();
	expect(result.input.command).toBe("ls");
});

test("null-strip: does NOT touch required field set to null", () => {
	const input: Record<string, unknown> = { command: null };
	const result = repairInput("bash", input, mockTools);

	expect(result.repairs).toHaveLength(0);
	expect(result.input.command).toBeNull();
});

test("unknown-param: removes hallucinated field", () => {
	const input: Record<string, unknown> = { command: "ls", hallucinatedParam: 42 };
	const result = repairInput("bash", input, mockTools);

	expect(result.repairs).toHaveLength(1);
	expect(result.repairs[0]).toEqual({ pattern: "unknown-param", field: "hallucinatedParam" });
	expect(result.input.hallucinatedParam).toBeUndefined();
});

test("bool-string: converts 'true' string on boolean field", () => {
	const input: Record<string, unknown> = { command: "ls", overwrite: "true" };
	const result = repairInput("bash", input, mockTools);

	expect(result.repairs).toHaveLength(1);
	expect(result.repairs[0]).toEqual({ pattern: "bool-string", field: "overwrite" });
	expect(result.input.overwrite).toBe(true);
});

test("multiple repairs in one call", () => {
	const input: Record<string, unknown> = {
		command: "ls",
		timeout: null,
		hallucinatedParam: 42,
		overwrite: "false",
	};
	const result = repairInput("bash", input, mockTools);

	expect(result.repairs.map((r) => r.pattern).sort()).toEqual([
		"bool-string",
		"null-strip",
		"unknown-param",
	]);
	expect(result.input.timeout).toBeUndefined();
	expect(result.input.hallucinatedParam).toBeUndefined();
	expect(result.input.overwrite).toBe(false);
	expect(result.input.command).toBe("ls");
});

test("no repairs when everything is valid", () => {
	const input: Record<string, unknown> = { command: "ls" };
	const result = repairInput("bash", input, mockTools);

	expect(result.repairs).toHaveLength(0);
	expect(result.input).toBe(input); // same reference
});

test("unknown tool passes through with no repairs", () => {
	const input: Record<string, unknown> = { wat: 1 };
	const result = repairInput("nonexistent", input, mockTools);

	expect(result.repairs).toHaveLength(0);
});

test("empty string-array scenario: string field with JSON array does NOT match", () => {
	// schema expects string but value looks like JSON — should NOT match string-array
	const input: Record<string, unknown> = { file_path: '["a.ts"]' };
	const result = repairInput("read", input, mockTools);

	// file_path is string, not array → no pattern matches
	expect(result.repairs).toHaveLength(0);
	expect(result.input.file_path).toBe('["a.ts"]');
});

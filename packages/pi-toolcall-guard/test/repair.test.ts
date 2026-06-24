import { describe, expect, it } from "vitest";
import { repairInput } from "../src/repair/index";

const bashTool = {
	name: "bash",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "The command to execute" },
			timeout: { type: "number", description: "Timeout in ms" },
			verbose: { type: "boolean", description: "Show verbose output" },
		},
		required: ["command"],
	},
};

const readTool = {
	name: "read",
	parameters: {
		type: "object",
		properties: {
			file_path: { type: "string" },
			limit: { type: "number" },
		},
		required: ["file_path"],
	},
};

const tools = [bashTool, readTool];

describe("repairInput", () => {
	it("returns empty repairs for clean input", () => {
		const input = { command: "ls" };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toEqual([]);
		expect(result.input).toBe(input);
	});

	// Pattern 1: bool-string
	it("coerces 'true' string to boolean on boolean schema field", () => {
		const input = { command: "ls", verbose: "true" };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toHaveLength(1);
		expect(result.repairs[0]).toEqual({ pattern: "bool-string", field: "verbose" });
		expect(input.verbose).toBe(true);
	});

	it("coerces 'false' string to boolean on boolean schema field", () => {
		const input = { command: "ls", verbose: "false" };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toHaveLength(1);
		expect(result.repairs[0].pattern).toBe("bool-string");
		expect(input.verbose).toBe(false);
	});

	it("does not coerce other strings on boolean field", () => {
		const input = { command: "ls", verbose: "maybe" };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toEqual([]);
		expect(input.verbose).toBe("maybe");
	});

	// Pattern 2: null-strip
	it("strips null on optional field", () => {
		const input = { command: "ls", timeout: null };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toHaveLength(1);
		expect(result.repairs[0]).toEqual({ pattern: "null-strip", field: "timeout" });
		expect(input).not.toHaveProperty("timeout");
	});

	it("keeps null on required field", () => {
		const input = { command: null };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toEqual([]);
		expect(input.command).toBeNull();
	});

	// Pattern 3: string-array
	it("parses JSON-stringified array on array schema field", () => {
		const listTool = {
			name: "list",
			parameters: {
				type: "object",
				properties: { items: { type: "array" } },
				required: [],
			},
		};
		const input = { items: '["a", "b", "c"]' };
		const result = repairInput("list", input, [listTool]);
		expect(result.repairs).toHaveLength(1);
		expect(result.repairs[0].pattern).toBe("string-array");
		expect(input.items).toEqual(["a", "b", "c"]);
	});

	it("does not parse strings that look like arrays when schema expects string", () => {
		const input = { file_path: '["a.ts"]' };
		const result = repairInput("read", input, tools);
		expect(result.repairs).toEqual([]);
		expect(input.file_path).toBe('["a.ts"]');
	});

	// Pattern 4: empty-object
	it("strips empty object on scalar field", () => {
		const input = { command: "ls", timeout: {} };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toHaveLength(1);
		expect(result.repairs[0].pattern).toBe("empty-object");
		expect(input).not.toHaveProperty("timeout");
	});

	it("keeps populated object on scalar field", () => {
		const input = { command: "ls", timeout: {} };
		// timeout is {} which matches pattern 4, so this still gets removed.
		// Use an object with keys to test "keeps populated object"
		const input2 = { command: "ls", timeout: { key: "val" } };
		const result = repairInput("bash", input2, tools);
		expect(result.repairs).toEqual([]);
		expect(input2.timeout).toEqual({ key: "val" });
	});

	// Pattern 5: unknown-param
	it("strips unknown params not in schema", () => {
		const input = { command: "ls", extraFlag: "--all" };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toHaveLength(1);
		expect(result.repairs[0]).toEqual({ pattern: "unknown-param", field: "extraFlag" });
		expect(input).not.toHaveProperty("extraFlag");
	});

	it("strips multiple unknown params", () => {
		const input = { command: "ls", foo: "bar", baz: 42 };
		const result = repairInput("bash", input, tools);
		expect(result.repairs).toHaveLength(2);
		expect(input).not.toHaveProperty("foo");
		expect(input).not.toHaveProperty("baz");
		expect(input.command).toBe("ls");
	});

	it("first-match-wins: null on optional field gets null-strip not unknown-param", () => {
		// null-strip (pattern 2) runs before unknown-param (pattern 5) for known fields
		const input = { command: "ls", timeout: null };
		const result = repairInput("bash", input, tools);
		expect(result.repairs[0].pattern).toBe("null-strip");
	});

	it("returns empty repairs when tool has no schema", () => {
		const input = { foo: "bar" };
		const result = repairInput("unknown-tool", input, tools);
		expect(result.repairs).toEqual([]);
	});

	it("returns empty repairs when tool list is empty", () => {
		const input = { command: "ls" };
		const result = repairInput("bash", input, []);
		expect(result.repairs).toEqual([]);
		expect(input.command).toBe("ls");
	});
});

import { describe, expect, it } from "vitest";
import { checkSchema } from "../src/schema/index";

const bashTool = {
	name: "bash",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "The command to execute" },
			timeout: { type: "number", description: "Timeout in ms" },
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
			offset: { type: "number" },
		},
		required: ["file_path"],
	},
};

const tools = [bashTool, readTool];

describe("checkSchema", () => {
	it("returns ok for valid input", () => {
		const result = checkSchema("bash", { command: "ls", timeout: 5000 }, tools);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it("returns ok for unknown tool (no schema to check against)", () => {
		const result = checkSchema("nonexistent", { foo: "bar" }, tools);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it("returns ok when tool has no parameters schema", () => {
		const result = checkSchema("bash", { command: "ls" }, [bashTool, { name: "no-schema-tool" }]);
		expect(result.ok).toBe(true);
	});

	it("blocks missing required field", () => {
		const result = checkSchema("bash", { timeout: 5000 }, tools);
		expect(result.ok).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].field).toBe("command");
		expect(result.violations[0].message).toContain("Missing required");
	});

	it("blocks multiple missing required fields", () => {
		const result = checkSchema("read", {}, tools);
		expect(result.ok).toBe(false);
		expect(result.violations.length).toBeGreaterThanOrEqual(1);
		expect(result.violations.find((v) => v.field === "file_path")).toBeTruthy();
	});

	it("blocks type mismatch: expected number got string", () => {
		const result = checkSchema("read", { file_path: "a.ts", offset: "not-a-number" }, tools);
		expect(result.ok).toBe(false);
		const typeErr = result.violations.find((v) => v.field === "offset");
		expect(typeErr).toBeTruthy();
		expect(typeErr!.message).toMatch(/expected.*number.*got.*string/i);
	});

	it("allows number→string coercion (string containing a valid number)", () => {
		// bash.timeout expects number, we send the string "5000" — this is allowed
		const bashNum = {
			...bashTool,
			parameters: {
				...bashTool.parameters,
				properties: { ...bashTool.parameters.properties },
			},
		};
		bashNum.parameters.properties.timeout.type = "number";
		const result = checkSchema("bash", { command: "ls", timeout: "5000" }, [bashNum, readTool]);
		expect(result.ok).toBe(true);
	});

	it("blocks array where object expected", () => {
		const objTool = {
			name: "obj",
			parameters: {
				type: "object",
				properties: { filter: { type: "object" } },
				required: [],
			},
		};
		const result = checkSchema("obj", { filter: [1, 2, 3] }, [objTool]);
		expect(result.ok).toBe(false);
	});

	it("includes blockReason when violations exist", () => {
		const result = checkSchema("bash", {}, tools);
		expect(result.ok).toBe(false);
		expect(result.blockReason).toBeTruthy();
		expect(result.blockReason).toContain("Schema violations");
		expect(result.blockReason).toContain("Missing required");
	});
});

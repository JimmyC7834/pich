import { describe, test, expect } from "vitest";
import { checkSchema } from "../../src/schema/index";

const mockTools = [
	{
		name: "bash",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				timeout: { type: "number" },
				description: { type: "string" },
			},
			required: ["command"],
		},
	},
	{
		name: "read",
		parameters: {
			type: "object",
			properties: {
				file_path: { type: "string" },
				offset: { type: "number" },
			},
			required: ["file_path"],
		},
	},
];

test("valid input → ok true, no violations", () => {
	const result = checkSchema("bash", { command: "ls", timeout: 30 }, mockTools);
	expect(result.ok).toBe(true);
	expect(result.violations).toHaveLength(0);
});

test("missing required field → ok false, block reason", () => {
	const result = checkSchema("bash", { timeout: 30 }, mockTools);
	expect(result.ok).toBe(false);
	expect(result.violations).toHaveLength(1);
	expect(result.violations[0].field).toBe("command");
	expect(result.violations[0].message).toContain("Missing required");
	expect(result.blockReason).toContain("command");
});

test("type mismatch: string vs number (non-numeric string)", () => {
	const result = checkSchema("bash", { command: "ls", timeout: "abc" }, mockTools);
	expect(result.ok).toBe(false);
	expect(result.violations).toHaveLength(1);
	expect(result.violations[0].field).toBe("timeout");
	expect(result.violations[0].message).toContain("Expected");
});

test("type mismatch: lenient on numeric strings", () => {
	// DeepSeek sends numbers as strings — guard is lenient
	const result = checkSchema("bash", { command: "ls", timeout: "30" }, mockTools);
	expect(result.ok).toBe(true);
});

test("missing required + type mismatch = multiple violations", () => {
	const result = checkSchema("bash", { timeout: "abc" }, mockTools);
	expect(result.ok).toBe(false);
	expect(result.violations.length).toBeGreaterThanOrEqual(2);
	const fields = result.violations.map((v) => v.field);
	expect(fields).toContain("command"); // missing required
	expect(fields).toContain("timeout"); // type mismatch
});

test("unknown tool passes through with ok=true", () => {
	const result = checkSchema("nonexistent", { wat: 1 }, mockTools);
	expect(result.ok).toBe(true);
	expect(result.violations).toHaveLength(0);
});

test("no tool parameters → passes through", () => {
	const result = checkSchema("bash", { wat: 1 }, [{ name: "bash" }]);
	expect(result.ok).toBe(true);
});

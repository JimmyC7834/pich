export interface SchemaViolation {
	field: string;
	message: string;
}

export interface SchemaCheckResult {
	ok: boolean;
	violations: SchemaViolation[];
	blockReason?: string;
}

/**
 * Validate a tool call's input against its parameter schema.
 *
 * Checks required fields and type mismatches. Returns a SchemaCheckResult
 * with ok=false + blockReason when the input is structurally invalid.
 */
export function checkSchema(
	toolName: string,
	input: Record<string, unknown>,
	tools: ReadonlyArray<{ name: string; parameters?: object }>,
): SchemaCheckResult {
	const tool = tools.find((t) => t.name === toolName);
	if (!tool?.parameters) return { ok: true, violations: [] };

	const violations: SchemaViolation[] = [];
	const schema = tool.parameters as Record<string, unknown>;
	const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
	const required: string[] = (schema.required as string[]) ?? [];

	// Required-field check
	for (const field of required) {
		if (input[field] === undefined || input[field] === null) {
			violations.push({
				field,
				message: `Missing required field "${field}" for tool "${toolName}"`,
			});
		}
	}

	// Type-mismatch check (covers common DeepSeek errors)
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		const propSchema = properties[key];
		if (!propSchema) continue;
		const expectedType = propSchema.type as string | undefined;
		if (!expectedType || expectedType === "any") continue;

		const actualType = Array.isArray(value) ? "array" : typeof value;

		if (actualType === "array" && expectedType !== "array") {
			violations.push({
				field: key,
				message: `Expected "${key}" to be ${expectedType}, got array`,
			});
		} else if (
			actualType !== expectedType &&
			!(expectedType === "number" && actualType === "string" && !isNaN(Number(value))) &&
			actualType !== "object"
		) {
			violations.push({
				field: key,
				message: `Expected "${key}" to be ${expectedType}, got ${actualType}`,
			});
		}
	}

	if (violations.length === 0) return { ok: true, violations: [] };

	return {
		ok: false,
		violations,
		blockReason:
			`[guard] Schema violations for ${toolName}:\n` +
			violations.map((v) => `  - ${v.message}`).join("\n"),
	};
}

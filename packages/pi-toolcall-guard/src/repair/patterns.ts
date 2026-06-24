export interface RepairPattern {
	name: string;
	/**
	 * Returns true if this pattern matches the given field/value.
	 * `schema` is the tool's parameters schema with `properties` and `required`.
	 */
	match(
		_toolName: string,
		field: string,
		value: unknown,
		schema: { properties: Record<string, { type?: string }>; required: string[] },
	): boolean;
	/**
	 * Transform the value. Return `undefined` to delete the field,
	 * or the new value to replace it.
	 */
	fix(value: unknown): unknown;
}

/**
 * Ordered list of repair patterns. Each pattern has a `match` predicate and
 * a `fix` transformer. First match wins per field.
 */
export const PATTERNS: RepairPattern[] = [
	// 1. Bool-string coercion: "true"/"false" → true/false on boolean schema fields
	{
		name: "bool-string",
		match: (_toolName, field, value, schema) => {
			const prop = schema.properties[field];
			return (
				prop?.type === "boolean" &&
				typeof value === "string" &&
				(value === "true" || value === "false")
			);
		},
		fix: (value) => (value as string) === "true",
	},

	// 2. Null-strip: remove null on optional fields
	{
		name: "null-strip",
		match: (_toolName, field, value, schema) => {
			return value === null && !schema.required.includes(field);
		},
		fix: () => undefined, // delete
	},

	// 3. JSON-string array parse: parse stringified arrays on array fields
	{
		name: "string-array",
		match: (_toolName, field, value, schema) => {
			if (schema.properties[field]?.type !== "array") return false;
			if (typeof value !== "string") return false;
			const trimmed = value.trim();
			return trimmed.startsWith("[") && trimmed.endsWith("]");
		},
		fix: (value) => JSON.parse(value as string),
	},

	// 4. Empty-object strip: remove {} on scalar fields
	{
		name: "empty-object",
		match: (_toolName, field, value, schema) => {
			const expectedType = schema.properties[field]?.type;
			if (!expectedType || expectedType === "object" || expectedType === "array") return false;
			if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
			return Object.keys(value as object).length === 0;
		},
		fix: () => undefined, // delete
	},

	// 5. Unknown-param strip: field not in schema properties
	{
		name: "unknown-param",
		match: (_toolName, field, _value, schema) => {
			return !(field in schema.properties);
		},
		fix: () => undefined, // delete
	},
];

export interface EnrichRule {
	id: string;
	test: RegExp;
	hint: string;
}

/**
 * Ordered rule table; first match wins. Order matters: stale-anchor must be
 * tested before the generic not-found patterns because anchor errors often
 * contain the words "not found".
 */
export const RULES: EnrichRule[] = [
	{
		id: "stale-anchor",
		test: /stale|hash mismatch|anchor .*(?:not found|changed|mismatch)/i,
		hint: "The file changed since you last read it. Re-read it to get fresh LINE#HASH anchors, then redo the edit against the current contents.",
	},
	{
		id: "deepseek-null-optional",
		test: /must not be null/i,
		hint: "DeepSeek sent null for an optional parameter — pass the field or use nullish coalescing to provide a default value.",
	},
	{
		id: "deepseek-string-array",
		test: /expected array.*got string/i,
		hint: "DeepSeek encoded an array as a JSON string instead of a proper array — use JSON.parse() or fix the value shape.",
	},
	{
		id: "deepseek-empty-object",
		test: /expected.*got object/i,
		hint: "DeepSeek sent an empty object but the schema expected a different type — pass the correct value or omit the parameter.",
	},
	{
		id: "deepseek-bool-string",
		test: /expected boolean.*got string/i,
		hint: "DeepSeek sent a string where a boolean was expected — pass true/false instead of a quoted string.",
	},
	{
		id: "deepseek-hallucinated-param",
		test: /unknown parameter/i,
		hint: "DeepSeek hallucinated a parameter that doesn't exist on this tool — check the tool's schema and remove the unknown parameter.",
	},
	{
		id: "deepseek-invalid-json",
		test: /unexpected token|invalid json/i,
		hint: "DeepSeek produced malformed JSON — check the argument values for unescaped quotes, trailing commas, or truncated input.",
	},
	{
		id: "schema",
		test: /invalid arguments|unknown (?:property|argument|key)|unexpected property|required property|expected .+ (?:but|, )/i,
		hint: "The arguments don't match this tool's schema. Check the exact parameter names and types for this tool, then resend the call.",
	},
	{
		id: "enoent",
		test: /ENOENT|no such file or directory|cannot find the (?:path|file)/i,
		hint: "The path doesn't exist. List the directory (ls) or search (find) to confirm the exact path before retrying.",
	},
	{
		id: "command-not-found",
		test: /command not found|is not recognized as|: not found/i,
		hint: "That command isn't available on this system (Windows). Use an installed equivalent, or verify it's on PATH.",
	},
	{
		id: "permission",
		test: /EACCES|EPERM|permission denied|operation not permitted/i,
		hint: "Permission denied. The path may be read-only or held open by another process.",
	},
];

export function enrichError(
	_toolName: string,
	text: string,
): { rule: string; text: string } | null {
	for (const rule of RULES) {
		if (rule.test.test(text)) {
			return { rule: rule.id, text: `${text}\n\n[guard] ${rule.hint}` };
		}
	}
	return null;
}

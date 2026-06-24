import { PATTERNS } from "./patterns";

export interface Repair {
	pattern: string;
	field: string;
}

export interface RepairResult {
	input: Record<string, unknown>;
	repairs: Repair[];
}

/**
 * Orchestrate repair patterns against a tool-call input.
 *
 * Runs all patterns from `patterns.ts` in order against every field,
 * mutating `input` in-place and collecting repairs. First match wins
 * per field. The returned `input` property is the same reference.
 */
export function repairInput(
	toolName: string,
	input: Record<string, unknown>,
	tools: ReadonlyArray<{ name: string; parameters?: object }>,
): RepairResult {
	const repairs: Repair[] = [];

	const tool = tools.find((t) => t.name === toolName);
	if (!tool?.parameters) return { input, repairs };

	const schema = tool.parameters as Record<string, unknown>;
	const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;
	const required: string[] = (schema.required as string[]) ?? [];

	const matchSchema = { properties, required };

	for (const [key, value] of Object.entries(input)) {
		for (const p of PATTERNS) {
			if (p.match(toolName, key, value, matchSchema)) {
				const fixed = p.fix(value);
				if (fixed === undefined) {
					delete input[key];
				} else {
					input[key] = fixed;
				}
				repairs.push({ pattern: p.name, field: key });
				break; // first match wins
			}
		}
	}

	return { input, repairs };
}

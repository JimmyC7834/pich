import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { getPathArg, normalizePathValue, pathExists, PATH_TOOLS } from "./paths";
import { nearMatches } from "./suggest";

export type PreflightOutcome =
	| { kind: "pass" }
	| { kind: "normalized"; key: string; value: string }
	| { kind: "block"; reason: string };

export function preflight(args: {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
}): PreflightOutcome {
	const { toolName, input, cwd } = args;
	const arg = getPathArg(toolName, input);
	if (!arg) return { kind: "pass" };

	const normalized = normalizePathValue(arg.value);
	const resolved = resolve(cwd, normalized);
	const meta = PATH_TOOLS[toolName];

	if (meta.isWrite) {
		try {
			mkdirSync(dirname(resolved), { recursive: true });
		} catch {
			return {
				kind: "block",
				reason: `Cannot write to "${arg.value}": failed to create parent directory.`,
			};
		}
		return normalized !== arg.value
			? { kind: "normalized", key: arg.key, value: normalized }
			: { kind: "pass" };
	}

	if (pathExists(resolved)) {
		return normalized !== arg.value
			? { kind: "normalized", key: arg.key, value: normalized }
			: { kind: "pass" };
	}

	const suggestions = nearMatches(normalized, cwd);
	const tail = suggestions.length
		? ` Did you mean: ${suggestions.join(", ")}?`
		: ` Use ls or find to locate it before retrying.`;
	return {
		kind: "block",
		reason: `Path "${arg.value}" does not exist relative to ${cwd}.${tail}`,
	};
}

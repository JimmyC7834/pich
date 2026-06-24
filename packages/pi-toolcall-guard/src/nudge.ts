export interface NudgeResult {
	rule: string;
	tool: string;
	reason: string;
}

// Pipes, redirections, command substitution, chaining → the model wants shell
// composition the native tools can't express. Never nudge these.
const COMPOUND_RE = /[|&;<>`]|\$\(/;

// find predicates/actions the native find tool may not honor → don't nudge.
const FIND_UNSAFE_RE =
	/(^|\s)-(?:exec|execdir|delete|type|newer|size|mtime|mmin|regex|iregex|prune|print0|maxdepth|mindepth)(\s|$)/;

function tokenize(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Classify a bash command. Returns a redirect to a native tool, or null to let
 * the command run as-is. Conservative: only the bare, single-purpose forms of
 * cat/grep/find/sed -i are redirected; anything composed or carrying a flag a
 * native tool can't honor passes through.
 */
export function nudge(command: string): NudgeResult | null {
	const cmd = command.trim();
	if (!cmd) return null;
	if (COMPOUND_RE.test(cmd)) return null;

	const tokens = tokenize(cmd);
	const bin = tokens[0];
	const rest = tokens.slice(1);
	const flags = rest.filter((t) => t.startsWith("-"));
	const operands = rest.filter((t) => !t.startsWith("-"));

	if (bin === "cat") {
		const flagsOk = flags.every((f) => f === "-n" || f === "-b");
		if (operands.length === 1 && flagsOk) {
			return {
				rule: "cat-read",
				tool: "read",
				reason:
					"Use the read tool, not cat — read returns LINE#HASH anchors required for edits.",
			};
		}
		return null;
	}

	if (bin === "grep") {
		const flagsOk = flags.every((f) => /^-[rRnilw]+$/.test(f));
		if (operands.length >= 1 && flagsOk) {
			return {
				rule: "grep",
				tool: "grep",
				reason:
					"Use the grep tool, not bash grep — its output is structured and collapsible.",
			};
		}
		return null;
	}

	if (bin === "find") {
		if (FIND_UNSAFE_RE.test(cmd)) return null;
		return {
			rule: "find",
			tool: "find",
			reason:
				"Use the find tool, not bash find — its output is structured and collapsible.",
		};
	}

	if (bin === "sed") {
		const inPlace = rest.some(
			(t) => /^-{1,2}i/.test(t) || t.startsWith("--in-place"),
		);
		if (inPlace) {
			return {
				rule: "sed-edit",
				tool: "edit",
				reason:
					"Use the edit tool, not sed -i — edit validates anchors and previews changes; sed -i bypasses both.",
			};
		}
		return null;
	}

	return null;
}

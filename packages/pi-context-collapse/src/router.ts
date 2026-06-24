import { estimateTokens } from "./tokens";
import { isUseless } from "./compressors/useless";
import type { ContentType } from "./cache";

export type { ContentType };

export const MIN_COLLAPSE_TOKENS = 200;

// "expand" is exempt so the recovery path never re-collapses the raw it just
// returned (the in-context expand result must stay byte-exact).
const EXEMPT_TOOLS = new Set(["read", "edit", "expand"]);

/** A line that is just a file path (no whitespace-separated content, no "file:line:" form). */
const BARE_PATH_RE = /^[\w.@~/\\-]+$/;

function isJsonObjectOrArray(text: string): boolean {
	const trimmed = text.trim();
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
	try {
		const v: unknown = JSON.parse(trimmed);
		return typeof v === "object" && v !== null;
	} catch {
		return false;
	}
}

function nonEmptyLines(text: string): string[] {
	return text.split("\n").filter((l) => l.trim().length > 0);
}

function ratio(lines: string[], pred: (l: string) => boolean): number {
	if (lines.length === 0) return 0;
	return lines.filter(pred).length / lines.length;
}

function duplicateRatio(lines: string[]): number {
	if (lines.length === 0) return 0;
	const unique = new Set(lines).size;
	return 1 - unique / lines.length;
}

/** Pick a content type to collapse, or null to pass through. Conservative: unsure → null. */
export function classify(toolName: string, text: string): ContentType | null {
	if (EXEMPT_TOOLS.has(toolName)) return null;
	// Useless results are usually short, so check before the token gate.
	if (isUseless(toolName, text)) return "useless";
	if (estimateTokens(text) < MIN_COLLAPSE_TOKENS) return null;

	if (isJsonObjectOrArray(text)) return "json";

	const lines = nonEmptyLines(text);
	if (lines.length >= 40 && ratio(lines, (l) => BARE_PATH_RE.test(l.trim())) >= 0.8) {
		return "paths";
	}
	if (lines.length >= 20 && duplicateRatio(lines) >= 0.3) {
		return "log";
	}
	return null;
}

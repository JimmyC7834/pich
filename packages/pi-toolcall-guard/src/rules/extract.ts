/**
 * Extraction helpers — turn pi events into matchable content.
 *
 * Prose extraction pulls text/thinking out of a streaming assistant message.
 * Tool extraction reconstructs the matchable "snapshot" for edit/write/bash
 * tool calls plus the file paths used for scope/glob gating. This is the local
 * stand-in for oh-my-pi's `matcherDigest`.
 */

/** Minimal shape of an assistant message content block we care about. */
interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
}

interface MessageLike {
	role?: string;
	content?: ContentBlock[] | unknown;
}

export interface ProseContent {
	text: string;
	thinking: string;
}

/** Concatenate text and thinking blocks from a streaming assistant message. */
export function extractProse(message: MessageLike | undefined): ProseContent {
	const text: string[] = [];
	const thinking: string[] = [];
	const content = message?.content;
	if (Array.isArray(content)) {
		for (const block of content as ContentBlock[]) {
			if (block?.type === "text" && typeof block.text === "string") {
				text.push(block.text);
			} else if (block?.type === "thinking" && typeof block.thinking === "string") {
				thinking.push(block.thinking);
			}
		}
	}
	return { text: text.join("\n"), thinking: thinking.join("\n") };
}

export interface ToolSnapshot {
	snapshot: string;
	filePaths: string[];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Build the matchable snapshot + file paths for a tool call.
 * - write: the file content; path = [input.path]
 * - edit:  the joined newText of every edit (where new violations appear)
 * - bash:  the command string; no file path
 * - other: JSON of the input; best-effort path discovery
 */
export function extractToolSnapshot(toolName: string, input: Record<string, unknown> | undefined): ToolSnapshot {
	const args = input ?? {};
	const path = asString(args.path) ?? asString(args.file_path) ?? asString(args.filename) ?? asString(args.target);
	const filePaths = path ? [path] : [];

	if (toolName === "write") {
		return { snapshot: asString(args.content) ?? "", filePaths };
	}
	if (toolName === "edit") {
		const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : [];
		const snapshot = edits
			.map((edit) => {
				// hashline replace_text dialect
				const replaced = asString(edit.newText) ?? asString(edit.new_string) ?? "";
				// hashline replace/append/prepend dialect: content lives in `lines`
				const lines = Array.isArray(edit.lines)
					? (edit.lines as unknown[]).filter((l): l is string => typeof l === "string").join("\n")
					: "";
				return [replaced, lines].filter((s) => s.length > 0).join("\n");
			})
			.join("\n");
		return { snapshot, filePaths };
	}
	if (toolName === "bash") {
		return { snapshot: asString(args.command) ?? "", filePaths };
	}
	let snapshot: string;
	try {
		snapshot = JSON.stringify(args);
	} catch {
		snapshot = "";
	}
	return { snapshot, filePaths };
}

/** De-duplicate rules by name, preserving order. */
export function dedupeByName<T extends { name: string }>(rules: readonly T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const rule of rules) {
		if (seen.has(rule.name)) {
			continue;
		}
		seen.add(rule.name);
		out.push(rule);
	}
	return out;
}

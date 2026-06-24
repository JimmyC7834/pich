import { collapseText } from "./collapse";
import type { ContentType } from "./router";
import { estimateTokens } from "./tokens";
import { hashContent } from "./handle";
import type { OriginalsCache } from "./cache";

// How many tokens of the newest conversation tail to leave fully intact. Recent
// tool results are what the agent is actively using — collapsing them is what
// caused re-reads/expand-thrash and rewrote the cache-hot prompt suffix every
// turn. Conversation only grows, so a message's distance-from-end is monotonic:
// once it crosses this line it stays collapsed, so the collapsed prefix is
// byte-stable across turns and the provider prompt cache holds.
function defaultProtectTokens(): number {
	return Number(process.env["PI_COLLAPSE_PROTECT_TOKENS"] ?? 6000);
}

interface AnyMsg {
	role?: string;
	toolName?: string;
	isError?: boolean;
	content?: unknown;
}

function textOf(m: AnyMsg): string {
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter((c): c is { type: "text"; text: string } => {
			return !!c && typeof c === "object" && (c as { type?: string }).type === "text";
		})
		.map((c) => c.text)
		.join("");
}

export interface PruneStats {
	trimmed: number;
	savedTokens: number;
}

export interface PruneOptions {
	protectTokens?: number;
	/** Memo of collapsed text by content hash — avoids recompressing the same old
	 *  result on every LLM call within a session. Also dedupes metric records. */
	memo?: Map<string, string>;
	/** Called once per newly-collapsed result (first time its hash is seen). */
	onTrim?: (info: {
		toolName: string;
		type: ContentType;
		rawTokens: number;
		collapsedTokens: number;
	}) => void;
}

/**
 * Lazy, cache-aware tool-result trimming. Walks newest -> oldest, leaves the
 * protected recent tail untouched, and collapses older non-error tool results
 * in place. Returns a NEW array (input messages are never mutated). Pure aside
 * from `cache.save` (recoverability) and the memo/metric callbacks.
 */
export function pruneMessages(
	messages: AnyMsg[],
	cache: OriginalsCache,
	opts: PruneOptions = {},
): { messages: AnyMsg[]; stats: PruneStats } {
	const protect = opts.protectTokens ?? defaultProtectTokens();
	const memo = opts.memo;
	const stats: PruneStats = { trimmed: 0, savedTokens: 0 };

	let suffixTokens = 0;
	// Build the output newest -> oldest, then reverse.
	const outRev: AnyMsg[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		const text = textOf(m);
		const toks = estimateTokens(text);
		const eligible = suffixTokens >= protect; // this message is past the protected tail
		suffixTokens += toks;

		if (!eligible || m.role !== "toolResult" || m.isError || !text) {
			outRev.push(m);
			continue;
		}

		const hash = hashContent(text);
		let collapsed = memo?.get(hash);
		let type: ContentType | undefined;
		const firstSeen = collapsed === undefined;
		if (collapsed === undefined) {
			const result = collapseText({ toolName: m.toolName ?? "", text, cache });
			collapsed = result?.collapsed; // undefined => passed through (not worth collapsing)
			type = result?.type;
			memo?.set(hash, collapsed ?? text); // memo even the no-op so we don't retry
		}
		if (!collapsed || collapsed === text) {
			outRev.push(m);
			continue;
		}

		const collapsedTokens = estimateTokens(collapsed);
		stats.trimmed++;
		stats.savedTokens += toks - collapsedTokens;
		if (firstSeen && type) {
			opts.onTrim?.({ toolName: m.toolName ?? "", type, rawTokens: toks, collapsedTokens });
		}
		outRev.push({ ...m, content: [{ type: "text", text: collapsed }] });
	}

	return { messages: outRev.reverse(), stats };
}

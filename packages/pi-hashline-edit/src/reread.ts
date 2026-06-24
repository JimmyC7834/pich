/**
 * Re-read awareness for the hashline read tool.
 *
 * Tracks the last FULL read (no offset/limit) of each path within a session so
 * that a re-read can be answered with an "unchanged, reuse your anchors" notice
 * or an anchored diff of what changed — instead of re-emitting the whole file.
 * State is passed in explicitly (owned by the read-tool closure) so this module
 * stays pure and testable.
 */

import { generateDiffString } from "./edit-diff";

/** Memory of the last full read of one path. */
export type RereadEntry = { content: string; lastWasStub: boolean };
export type RereadState = Map<string, RereadEntry>;

/**
 * Above this many diff lines, a changed re-read shows the full file instead of
 * the diff: a large diff is no longer cheaper or clearer than a fresh read.
 */
export const REREAD_DIFF_MAX_LINES = 80;

/** Count rendered lines, ignoring a single trailing-newline sentinel. */
export function countVisibleLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

export type RereadAction = "first" | "stub" | "force-full" | "changed";

/**
 * Decide how to answer a full read given the prior entry for the same path.
 * - no prior entry        → "first"      (record and show full)
 * - identical, last real  → "stub"       (show the unchanged notice)
 * - identical, last stub  → "force-full" (loop-break: show full again)
 * - different             → "changed"    (show diff or full)
 */
export function decideReread(
	prev: RereadEntry | undefined,
	curr: string,
): RereadAction {
	if (prev === undefined) return "first";
	if (prev.content === curr) return prev.lastWasStub ? "force-full" : "stub";
	return "changed";
}

/** Notice emitted when a re-read finds byte-identical content. */
export function renderUnchangedNotice(content: string): string {
	return (
		`[hashline] Unchanged since last read ` +
		`(${countVisibleLines(content)} lines). Reuse your anchors.`
	);
}

/**
 * Notice emitted when a re-read finds different content. Prefers an anchored
 * diff (whose context/"+" lines carry current LINE#HASH anchors); falls back to
 * the full preview when the diff is large enough that a fresh read is clearer.
 */
export function renderChangedNotice(
	prev: string,
	curr: string,
	fullPreviewText: string,
	maxDiffLines: number = REREAD_DIFF_MAX_LINES,
): { text: string; mode: "changed-diff" | "changed-full" } {
	const { diff } = generateDiffString(prev, curr);
	const diffLineCount = diff.length === 0 ? 0 : diff.split("\n").length;
	if (diffLineCount > 0 && diffLineCount <= maxDiffLines) {
		return {
			mode: "changed-diff",
			text:
				`[hashline] Changed since last read — diff below (anchors current):\n\n` +
				diff,
		};
	}
	return {
		mode: "changed-full",
		text:
			`[hashline] Changed since last read ` +
			`(${diffLineCount}-line diff; showing full file):\n\n` +
			fullPreviewText,
	};
}

export type RereadOutcome =
	| { text: string; mode: "unchanged" | "changed-diff" | "changed-full" }
	| null;

/**
 * Consult and update re-read state for one full read. Returns the notice to
 * emit, or null when the caller should emit its normal full preview (first read
 * or loop-break). Always records the current content as the new baseline.
 */
export function applyReread(
	state: RereadState,
	absPath: string,
	curr: string,
	fullPreviewText: string,
	maxDiffLines: number = REREAD_DIFF_MAX_LINES,
): RereadOutcome {
	const prev = state.get(absPath);
	const action = decideReread(prev, curr);
	switch (action) {
		case "first":
		case "force-full":
			state.set(absPath, { content: curr, lastWasStub: false });
			return null;
		case "stub":
			state.set(absPath, { content: curr, lastWasStub: true });
			return { text: renderUnchangedNotice(curr), mode: "unchanged" };
		case "changed": {
			state.set(absPath, { content: curr, lastWasStub: false });
			const { text, mode } = renderChangedNotice(
				prev!.content,
				curr,
				fullPreviewText,
				maxDiffLines,
			);
			return { text, mode };
		}
	}
}

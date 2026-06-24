/**
 * pi-autocompact — proactive compaction extension (formerly deepseek-compact)
 *
 * Two responsibilities:
 *
 * 1. TRIGGER — hooks turn_end, checks context usage, and triggers
 *    compaction at a custom threshold: 50% of context window or 256K
 *    tokens (whichever is lower). This is far more proactive than the
 *    default trigger (contextWindow - 16K). When the compaction was
 *    auto-triggered (not a manual /compact), it injects a follow-up
 *    turn so the agent resumes the task instead of stalling idle.
 *
 * 2. SUMMARIZE — hooks session_before_compact and summarizes with a
 *    configurable model (PI_AUTOCOMPACT_MODEL, default DeepSeek V4 Flash —
 *    cheap, no thinking) using a handoff-inspired structured format. Much
 *    cheaper than using the conversation model for summarization. Falls back
 *    to the live session model if the configured one is unavailable.
 *
 * Setup:
 *   Disable default auto-compaction in ~/.pi/agent/settings.json
 *   or <project>/.pi/settings.json to avoid double triggers:
 *
 *     { "compaction": { "enabled": false } }
 *
 *   Optionally pick the summarization model:
 *
 *     PI_AUTOCOMPACT_MODEL="anthropic/claude-haiku-4-5"
 *
 * Auto-discovery: place in ~/.pi/agent/extensions/ and restart pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { resolveCompactModel } from "./src/model.js";

/** Custom compaction threshold: 50% of window, capped at 256K tokens */
function shouldCompactAtThreshold(tokens: number, contextWindow: number): boolean {
	const threshold = Math.min(contextWindow * 0.5, 256_000);
	return tokens > threshold;
}

// ── Pre-compaction cleanup: trim bulky tool-result records ──
// Keep this many messages at the head and tail of the compact zone verbatim.
const HEAD_KEEP = 2;
const TAIL_KEEP = 2;
/** Only elide a tool result whose text exceeds this many characters. */
const MIN_ELIDE_CHARS = 500;

interface ElideStats {
	/** Total messages in the compact zone. */
	zoneMessages: number;
	/** Messages in the middle band (zone minus head/tail) that are eligible. */
	middleMessages: number;
	/** Tool-result records found in the middle band. */
	toolResultsInMiddle: number;
	/** Tool-result records actually elided (large, non-error). */
	toolResultsElided: number;
	/** Characters removed by elision (original text minus marker text). */
	charsElided: number;
}

/**
 * Elide bulky tool-result records from the *middle* of the compact zone before
 * summarization, leaving an informative marker in their place. Untouched:
 *  - the first HEAD_KEEP and last TAIL_KEEP messages (head/tail of the zone),
 *  - tool *calls* (so file paths / "what was attempted" survive),
 *  - error results (isError — that's where debugging signal lives),
 *  - small results (< MIN_ELIDE_CHARS).
 *
 * Returns a NEW array; the input is never mutated. This only shapes the text we
 * hand to the summarizer — it does not touch the stored session, the compaction
 * cut point, or the head/tail-keeping logic of compaction itself.
 */
function trimToolRecordsForSummary<T>(messages: T[]): { messages: T[]; stats: ElideStats } {
	const stats: ElideStats = {
		zoneMessages: messages.length,
		middleMessages: Math.max(0, messages.length - HEAD_KEEP - TAIL_KEEP),
		toolResultsInMiddle: 0,
		toolResultsElided: 0,
		charsElided: 0,
	};

	const middleEnd = messages.length - TAIL_KEEP; // exclusive
	const trimmed = messages.map((message, index) => {
		// Head and tail of the zone pass through verbatim — only the middle is eligible.
		if (index < HEAD_KEEP || index >= middleEnd) return message;

		const msg = message as any;
		if (msg?.role !== "toolResult") return message; // leave tool calls + prose alone
		stats.toolResultsInMiddle++;

		// Never elide errors — the failure text is the most valuable bit for the summary.
		if (msg.isError) return message;

		const text: string = Array.isArray(msg.content)
			? msg.content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("")
			: "";
		if (text.length < MIN_ELIDE_CHARS) return message;

		const marker = `[${msg.toolName ?? "tool"} tool result → ok, ~${text.length.toLocaleString()} chars elided]`;
		stats.toolResultsElided++;
		stats.charsElided += text.length - marker.length;
		return { ...msg, content: [{ type: "text", text: marker }] } as T;
	});

	return { messages: trimmed, stats };
}

/**
 * Append one elide record to <cwd>/.pi/pi-autocompact/elide.jsonl so the
 * trimming effectiveness can be tracked over time. Best-effort: any failure is
 * swallowed so logging can never break compaction.
 */
function recordElideStats(cwd: string, record: Record<string, unknown>): void {
	try {
		const dir = path.join(cwd, ".pi", "pi-autocompact");
		fs.mkdirSync(dir, { recursive: true });
		const gitignore = path.join(dir, ".gitignore");
		if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, "*\n", "utf-8");
		fs.appendFileSync(
			path.join(dir, "elide.jsonl"),
			`${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
			"utf-8",
		);
	} catch {
		/* tracking is best-effort — never let it break compaction */
	}
}

export default function (pi: ExtensionAPI) {
	// ── Trigger: check context after each turn, compact early ──
	pi.on("turn_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;

		if (shouldCompactAtThreshold(usage.tokens, usage.contextWindow)) {
			ctx.ui.notify(
				`Context at ${usage.tokens.toLocaleString()} tokens (${usage.percent?.toFixed(0)}%) — triggering compact`,
				"info",
			);
			// Auto-continue: compaction fires at turn_end, after the agent has
			// already yielded. Without a follow-up the session sits idle, so once
			// compaction finishes we inject a turn to resume the task. This only
			// attaches to threshold-triggered compactions — manual /compact is
			// untouched.
			ctx.compact({
				onComplete: () => {
					pi.sendUserMessage(
						"Context was automatically compacted to free up space. Review the summary above " +
							"and continue the in-progress task exactly where you left off, following the Next " +
							"Steps. If the task was already fully complete, briefly confirm that instead of " +
							"starting new work.",
					);
				},
				onError: (error) => {
					ctx.ui.notify(`Auto-compact failed, not resuming: ${error.message}`, "warning");
				},
			});
		}
	});

	// ── Summarize: handle the actual compaction with DeepSeek Flash ──
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// Pick the summarization model: PI_AUTOCOMPACT_MODEL override, else the
		// cheap DeepSeek Flash default. If neither is in the registry, fall back
		// to the live session model so compaction still happens.
		const ref = resolveCompactModel(process.env.PI_AUTOCOMPACT_MODEL);
		const session = ctx.model;
		const model =
			ctx.modelRegistry.find(ref.provider, ref.model) ??
			(session ? ctx.modelRegistry.find(session.provider, session.id) : undefined);
		if (!model) {
			ctx.ui.notify(
				`Compaction model ${ref.provider}/${ref.model} not found and no session model — using default compaction`,
				"warning",
			);
			return;
		}

		// Resolve auth for the summarization model
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "warning");
			return;
		}
		if (!auth.apiKey) {
			ctx.ui.notify("No API key for DeepSeek — falling back to default compaction", "warning");
			return;
		}

		// Combine all messages for the summary
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		// Pre-compaction cleanup: elide bulky tool-result records from the middle
		// of the compact zone before summarizing. Head/tail messages, tool calls,
		// errors, and small results are left untouched.
		const { messages: trimmedMessages, stats } = trimToolRecordsForSummary(allMessages);

		// Convert messages to readable text format
		const conversationText = serializeConversation(convertToLlm(trimmedMessages));

		// Elide rate relative to the pre-trim size of the serialized zone.
		const reductionPct =
			stats.charsElided > 0 ? (stats.charsElided / (conversationText.length + stats.charsElided)) * 100 : 0;
		recordElideStats(ctx.cwd, {
			tokensBefore,
			zoneMessages: stats.zoneMessages,
			middleMessages: stats.middleMessages,
			toolResultsInMiddle: stats.toolResultsInMiddle,
			toolResultsElided: stats.toolResultsElided,
			charsElided: stats.charsElided,
			charsAfter: conversationText.length,
			reductionPct: Number(reductionPct.toFixed(1)),
		});

		ctx.ui.notify(
			`DeepSeek compact: summarizing ${trimmedMessages.length} messages ` +
				`(${tokensBefore.toLocaleString()} tokens; elided ${stats.toolResultsElided}/${stats.toolResultsInMiddle} ` +
				`tool results, −${stats.charsElided.toLocaleString()} chars / ${reductionPct.toFixed(0)}%)...`,
			"info",
		);

		// Include previous summary context if available (iterative compaction)
		const previousContext = previousSummary
			? `\n\nPrevious session summary for context (build upon this, don't repeat it):\n${previousSummary}`
			: "";

		// Build the summarization prompt using the blended handoff format
		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `You are a conversation summarizer for a coding agent. Create a structured, comprehensive summary of this conversation that captures everything needed to continue the work seamlessly.

The summary will be injected into the agent's context alongside the most recent conversation turns, so focus on what happened *before* those recent turns.

${previousContext}

Use this format:

## Goal / Context
What is the user trying to accomplish? What has been achieved so far?

## Key Decisions
- **[Decision]**: [Rationale and trade-offs considered]

## Current State
### Done
- [x] [Completed tasks with key details]
### In Progress
- [ ] [Currently being worked on]
### Blocked
- [Issues or blockers, if any]

## Critical Context
- File paths, important data values, environment details the model must know
- Any non-obvious constraints or gotchas

## Open Questions
- [Unresolved questions, decisions pending, ambiguities]

## Next Steps
1. [Ordered list of what should happen next]

Also track which files were read and which were modified during this conversation segment:

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>

Guidelines:
- Be concise but thorough — this replaces the full conversation history being summarized
- Include specific file paths, function names, and error messages where relevant
- Preserve the reasoning behind key decisions so the model doesn't re-argue them
- If the previous summary exists, merge it with new information rather than repeating

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			const response = await complete(model, { messages: summaryMessages }, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 4096,
				signal,
			});

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) ctx.ui.notify("Compaction summary was empty — using default", "warning");
				return;
			}

			// Return compaction content — SessionManager adds id/parentId
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`DeepSeek compact failed: ${message}`, "error");
			// Fall back to default compaction on error
			return;
		}
	});
}

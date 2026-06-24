import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Metrics } from "./src/metrics";
import { preflight } from "./src/preflight";
import { enrichError } from "./src/enrich";
import { checkSchema } from "./src/schema/index";
import { repairInput } from "./src/repair/index";
import { nudge } from "./src/nudge";
import { analyzeBashCommand, headlessBlockReason } from "./src/destructive";
import { RuleEngine, type RuleDecision } from "./src/rules/engine";
import { loadRules } from "./src/rules/loader";
import { DEFAULT_SETTINGS } from "./src/rules/types";
import { StreamWatcher } from "./src/stream/watcher";

// PI_SUBAGENT_DEPTH is 0 (or unset) in the main session and >= 1 in spawned
// subagent processes. The destructive-bash guard (merged from bash-guard)
// branches on this: interactive ctx.ui.confirm in the main session, headless
// hard-block for catastrophic operations in subagents (no stdin/UI there).
const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const IS_SUBAGENT = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

// Minimal structural view of the bits of ExtensionContext the bash guard needs.
interface BashGuardCtx {
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}

export default function (pi: ExtensionAPI): void {
	// Co-locate runtime artifacts with pi's own per-project state under
	// <cwd>/.pi/ (alongside .pi/sessions, .pi/code-vocab). Override with
	// PI_GUARD_DIR to pin a fixed location.
	const dir = process.env.PI_GUARD_DIR ?? join(process.cwd(), ".pi", "guard");
	let metrics: Metrics;
	try {
		mkdirSync(dir, { recursive: true });
		metrics = new Metrics(join(dir, ".pi-guard-metrics.jsonl"));
	} catch {
		// Cannot create the metrics dir — degrade to a no-op rather than throwing
		// out of the extension entrypoint and disrupting the host session.
		return;
	}

	// Tools whose most recent call this session was blocked by preflight. A later
	// successful (non-error) result for the same tool is counted as a recovery —
	// the rough signal that the block's guidance worked. Heuristic, not exact.
	const pendingBlock = new Set<string>();

	// Lazily resolve which tools are actually registered this session. Queried on
	// first use (not at registration) so sibling extensions have finished loading
	// and registering their tools. A nudge fires only when its target tool exists
	// — otherwise we'd redirect the model to a tool this harness doesn't have
	// (e.g. harnesses with no `grep`/`find` tool, only bash + vocab search).
	let availableTools: Set<string> | null = null;
	const toolExists = (name: string): boolean => {
		if (availableTools === null) {
			try {
				availableTools = new Set(pi.getAllTools().map((t) => t.name));
			} catch {
				availableTools = new Set();
			}
		}
		return availableTools.has(name);
	};

	// Reminders pending application at tool_result, keyed by toolCallId.
	const pendingReminders = new Map<string, RuleDecision>();

	// ── Destructive-bash guard (merged from the former bash-guard extension) ──
	pi.registerFlag("bash-guard-auto-allow", {
		description: "If set, allow high-risk bash commands when no UI is available (non-interactive modes) instead of blocking.",
		type: "boolean",
		default: false,
	});
	// Avoid annoying retry loops: if the exact command was aborted recently, auto-block it.
	const recentlyAborted = new Map<string, number>();
	const ABORT_REMEMBER_MS = 60_000;

	async function guardBash(command: string, ctx: BashGuardCtx): Promise<{ block: true; reason: string } | null> {
		if (!command) return null;

		// Headless subagent: hard-block catastrophic ops, never prompt.
		if (IS_SUBAGENT) {
			const reason = headlessBlockReason(command);
			if (!reason) return null;
			metrics.record({ kind: "bash_guard", toolName: "bash", outcome: "headless_block", severity: "high", reasons: reason });
			return {
				block: true,
				reason:
					`Blocked by guard: ${reason}. This is a non-interactive subagent session — catastrophic operations are not permitted. ` +
					"Propose a safer alternative or ask the parent agent to confirm with the user.",
			};
		}

		// Main session: only high-severity commands are subject to a prompt.
		const risk = analyzeBashCommand(command);
		if (!risk || risk.severity !== "high") return null;

		const now = Date.now();
		const lastAbort = recentlyAborted.get(command);
		if (lastAbort && now - lastAbort < ABORT_REMEMBER_MS) {
			metrics.record({ kind: "bash_guard", toolName: "bash", outcome: "repeat_block", severity: risk.severity, reasons: risk.reasons.join("; ") });
			return {
				block: true,
				reason: "Blocked by guard: command was already aborted recently. Ask the user for a safer alternative; do not retry the same command.",
			};
		}

		if (!ctx.hasUI) {
			// No UI to confirm: allow only if explicitly opted in, else block.
			if (pi.getFlag("--bash-guard-auto-allow")) return null;
			metrics.record({ kind: "bash_guard", toolName: "bash", outcome: "prompt_block", severity: risk.severity, reasons: risk.reasons.join("; ") });
			return {
				block: true,
				reason: `Blocked by guard (no UI to confirm a ${risk.severity}-risk command): ${risk.reasons.join("; ")}. Pass --bash-guard-auto-allow to permit, or propose a safer alternative.`,
			};
		}

		const reasonsText = risk.reasons.map((r) => `• ${r}`).join("\n");
		const ok = await ctx.ui.confirm(
			"Potentially destructive bash command",
			`Command flagged as ${risk.severity.toUpperCase()} risk:\n\n${reasonsText}\n\nCommand:\n${command}\n\nRun it?`,
		);
		if (ok) {
			metrics.record({ kind: "bash_guard", toolName: "bash", outcome: "prompt_allow", severity: risk.severity, reasons: risk.reasons.join("; ") });
			return null;
		}
		recentlyAborted.set(command, now);
		metrics.record({ kind: "bash_guard", toolName: "bash", outcome: "prompt_block", severity: risk.severity, reasons: risk.reasons.join("; ") });
		return {
			block: true,
			reason: "Blocked by user via guard (potentially destructive command). Ask the user for confirmation or propose a non-destructive alternative.",
		};
	}

	// Build the rule engine lazily on first tool_call using the event's cwd
	// (rules live under <cwd>/.pi/guard-rules plus the bundled set). Memoized so
	// disk is read once per session.
	let engine: RuleEngine | null = null;
	const getEngine = (cwd: string): RuleEngine => {
		if (engine === null) {
			try {
				const rules = loadRules({ cwd, builtinRules: true, disabledRules: [] });
				engine = new RuleEngine(rules, DEFAULT_SETTINGS);
			} catch {
				engine = new RuleEngine([], DEFAULT_SETTINGS);
			}
		}
		return engine;
	};

	pi.on("tool_call", async (event, ctx) => {
		try {
			const input = (event.input ?? {}) as Record<string, unknown>;

			if (event.toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";

				// Destructive-command safety gates before the style nudge.
				const bashBlock = await guardBash(command, ctx);
				if (bashBlock) return bashBlock;

				// Native-tool nudge for bash (redirect cat/grep/sed to dedicated tools).
				const n = nudge(command);
				if (n && toolExists(n.tool)) {
					metrics.record({ kind: "nudge", toolName: "bash", rule: n.rule, tool: n.tool });
					return { block: true, reason: `[guard] ${n.reason}` };
				}
			} else {
				// Path preflight for file tools (normalize in place, or block).
				const out = preflight({ toolName: event.toolName, input, cwd: ctx.cwd });
				if (out.kind === "normalized") {
					input[out.key] = out.value;
					metrics.record({ kind: "preflight", outcome: "normalized", toolName: event.toolName });
				} else if (out.kind === "block") {
					pendingBlock.add(event.toolName);
					metrics.record({ kind: "preflight", outcome: "block", toolName: event.toolName });
					return { block: true, reason: out.reason };
				}
			}

			// Repair common DeepSeek issues (null optionals, unknown params).
			const tools = availableTools === null
				? []
				: pi.getAllTools().filter((t) => availableTools?.has(t.name));
			const { repairs } = repairInput(event.toolName, input, tools);
			for (const r of repairs) {
				metrics.record({ kind: "repair", toolName: event.toolName, pattern: r.pattern, field: r.field });
			}

			// Schema validation (after repair, before rules engine).
			const violationResult = checkSchema(event.toolName, input, tools);
			if (!violationResult.ok) {
				metrics.record({
					kind: "schema_block",
					toolName: event.toolName,
					violations: violationResult.violations.map((v) => v.field).join(","),
				});
				return { block: true, reason: violationResult.blockReason };
			}

			// Content rules (all tools) on the possibly-normalized input.
			const decision = getEngine(ctx.cwd).checkToolCall(event.toolName, input);
			if (decision) {
				metrics.record({ kind: "rule", toolName: event.toolName, action: decision.action, rules: decision.ruleNames.join(",") });
				if (decision.action === "block") {
					return { block: true, reason: decision.text };
				}
				pendingReminders.set(event.toolCallId, decision);
			}
			return;
		} catch {
			// Never throw into beforeToolCall — a throw blocks the tool (agent-loop).
			return;
		}
	});

	// Real-time stream interrupt (prose rules). Best-effort and gated: disable
	// with PI_GUARD_STREAM=0. Reactive — the keyword has already streamed by the
	// time we can abort; we abort the turn and re-inject the reminder.
	if (process.env.PI_GUARD_STREAM !== "0") {
		const watcher = new StreamWatcher();
		pi.on("turn_start", () => watcher.onTurnStart());
		pi.on("message_update", (event, ctx) => {
			try {
				const engine = getEngine(ctx.cwd);
				watcher.onMessageUpdate(
					event.message,
					(text, source) => engine.checkProse(text, source),
					{
						abort: () => ctx.abort(),
						inject: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
						notify: ctx.hasUI ? (m) => ctx.ui.notify(`[guard] ${m}`, "warning") : undefined,
						record: (rule, source) =>
							metrics.record({ kind: "stream", toolName: "(stream)", source, rule }),
					},
				);
			} catch {
				// Never throw into the stream loop.
			}
		});
	}

	pi.on("tool_result", (event) => {
		const reminder = pendingReminders.get(event.toolCallId);
		if (reminder) {
			pendingReminders.delete(event.toolCallId);
		}
		if (!event.isError) {
			if (pendingBlock.has(event.toolName)) {
				pendingBlock.delete(event.toolName);
				metrics.record({ kind: "preflight_recovered", toolName: event.toolName });
			}
			if (reminder) {
				return { content: [{ type: "text" as const, text: reminder.text }, ...event.content] };
			}
			return;
		}
		if (event.content.length !== 1 || event.content[0]?.type !== "text") return;
		const text = (event.content[0] as { type: "text"; text: string }).text;
		const enriched = enrichError(event.toolName, text);
		metrics.record({ kind: "enrich", matched: !!enriched, rule: enriched?.rule, toolName: event.toolName });
		if (!enriched) return;
		return { content: [{ type: "text" as const, text: enriched.text }] };
	});
}

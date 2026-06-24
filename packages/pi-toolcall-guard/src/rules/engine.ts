import { dedupeByName, extractToolSnapshot } from "./extract";
import { RuleMonitor } from "./monitor";
import { renderInterrupt, renderMany, renderToolReminder, renderStreamReminder, shouldInterrupt } from "./render";
import type { Rule, TtsrSettings } from "./types";

export interface RuleDecision {
	action: "block" | "remind";
	/** Rendered <system-interrupt> (block) or <system-reminder> (remind) text. */
	text: string;
	ruleNames: string[];
}

/**
 * Thin wrapper over RuleMonitor: turns a tool call into a block/remind decision.
 * Tool-path only — it is never fed prose. Stateless across calls (no injection
 * suppression), so a repeated violation re-fires every time, which is intended:
 * a block must be re-corrected, and a reminder is cheap to repeat.
 */
export class RuleEngine {
	readonly #monitor: RuleMonitor;
	readonly #settings: TtsrSettings;

	constructor(rules: readonly Rule[], settings: TtsrSettings) {
		this.#settings = settings;
		this.#monitor = new RuleMonitor(settings);
		for (const rule of rules) {
			this.#monitor.addRule(rule);
		}
	}

	hasRules(): boolean {
		return this.#monitor.hasRules();
	}

	checkToolCall(toolName: string, input: Record<string, unknown> | undefined): RuleDecision | undefined {
		if (!this.#monitor.hasRules()) {
			return undefined;
		}
		const { snapshot, filePaths } = extractToolSnapshot(toolName, input);
		const matches = this.#monitor.check(snapshot, { source: "tool", toolName, filePaths });
		if (matches.length === 0) {
			return undefined;
		}
		const blocking = matches.filter((rule) => shouldInterrupt(rule, "tool", this.#settings));
		if (blocking.length > 0) {
			const rules = dedupeByName(blocking);
			return { action: "block", text: renderMany(renderInterrupt, rules, filePaths[0]), ruleNames: rules.map((r) => r.name) };
		}
		const rules = dedupeByName(matches);
		return { action: "remind", text: renderMany(renderToolReminder, rules, filePaths[0]), ruleNames: rules.map((r) => r.name) };
	}

	/**
	 * Check a prose snapshot (a tail slice of the streaming assistant message).
	 * Returns a compact interrupt decision only for rules whose interrupt mode
	 * fires on this prose source; soft prose matches are ignored in v1.
	 */
	checkProse(text: string, source: "text" | "thinking"): { text: string; ruleNames: string[] } | undefined {
		if (!this.#monitor.hasRules() || text.length === 0) {
			return undefined;
		}
		const matches = this.#monitor.check(text, { source });
		const interrupting = matches.filter((rule) => shouldInterrupt(rule, source, this.#settings));
		if (interrupting.length === 0) {
			return undefined;
		}
		const rules = dedupeByName(interrupting);
		return { text: renderMany(renderStreamReminder, rules), ruleNames: rules.map((r) => r.name) };
	}
}

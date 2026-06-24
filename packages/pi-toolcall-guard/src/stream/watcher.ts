import { extractProse } from "../rules/extract";

/** Tail length (chars) scanned per delta. Must exceed the longest expected match. */
export const STREAM_WINDOW = 120;

export type ProseCheck = (
	text: string,
	source: "text" | "thinking",
) => { text: string; ruleNames: string[] } | undefined;

export interface StreamActions {
	/** Abort the in-flight assistant turn. */
	abort(): void;
	/** Inject the reminder as a follow-up message. */
	inject(text: string): void;
	/** Optional UI notification. */
	notify?(message: string): void;
	/** Optional metric sink (called once per fired rule). */
	record?(rule: string, source: "text" | "thinking"): void;
}

/**
 * Watches the streaming assistant message and interrupts on the first prose
 * rule hit. Scans only the tail of the accumulated text (O(1) per token).
 * Stateful: at most one abort per message (reset via onTurnStart) and at most
 * one fire per rule per session (in-memory fired-set). Reactive by nature —
 * the keyword's tokens have already streamed by the time we abort.
 */
export class StreamWatcher {
	readonly #window: number;
	readonly #fired = new Set<string>();
	#abortedThisMessage = false;

	constructor(window: number = STREAM_WINDOW) {
		this.#window = window;
	}

	/** Reset the per-message abort guard. Wire to turn_start. */
	onTurnStart(): void {
		this.#abortedThisMessage = false;
	}

	/**
	 * Inspect the current streaming snapshot. Returns the rule names that fired
	 * (and triggered abort+inject), or null if nothing fired.
	 */
	onMessageUpdate(message: unknown, check: ProseCheck, actions: StreamActions): string[] | null {
		if (this.#abortedThisMessage) {
			return null;
		}
		const prose = extractProse(message as Parameters<typeof extractProse>[0]);
		for (const [source, content] of [
			["text", prose.text],
			["thinking", prose.thinking],
		] as Array<["text" | "thinking", string]>) {
			if (content.length === 0) {
				continue;
			}
			const decision = check(content.slice(-this.#window), source);
			if (!decision) {
				continue;
			}
			const fresh = decision.ruleNames.filter((name) => !this.#fired.has(name));
			if (fresh.length === 0) {
				continue; // every matched rule already fired this session
			}
			this.#abortedThisMessage = true;
			for (const name of fresh) {
				this.#fired.add(name);
			}
			actions.abort();
			actions.inject(decision.text);
			actions.notify?.(`stream interrupt: ${fresh.join(", ")}`);
			for (const name of fresh) {
				actions.record?.(name, source);
			}
			return fresh;
		}
		return null;
	}
}

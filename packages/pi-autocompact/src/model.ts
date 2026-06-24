/** A provider/model pair the compactor can summarize with. */
export interface CompactModelRef {
	provider: string;
	model: string;
}

/** Cheap default: DeepSeek V4 Flash — fast, no thinking, made for summarization. */
export const DEFAULT_COMPACT_MODEL: CompactModelRef = {
	provider: "deepseek",
	model: "deepseek-v4-flash",
};

/**
 * Resolve which model summarizes compactions.
 *
 * `PI_AUTOCOMPACT_MODEL="provider/model"` (e.g. `anthropic/claude-haiku-4-5`)
 * overrides the cheap default. Anything malformed (missing/empty provider or
 * model) is ignored and the default stands. If the resolved model turns out to
 * be unavailable in the registry at runtime, the caller falls back to the live
 * session model so compaction still happens.
 */
export function resolveCompactModel(env: string | undefined): CompactModelRef {
	const raw = env?.trim();
	if (raw) {
		const i = raw.indexOf("/");
		// require a non-empty provider AND model around a single "/"
		if (i > 0 && i < raw.length - 1) {
			return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
		}
	}
	return DEFAULT_COMPACT_MODEL;
}

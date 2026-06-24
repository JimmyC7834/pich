/**
 * Core types for the lightweight TTSR (Time-Traveling Stream Rules) extension.
 *
 * A `Rule` is a user- or project-defined guardrail. When the model's output
 * (prose, thinking, or an edit/write tool's arguments) matches a rule's regex
 * `condition`, the rule either interrupts the turn or folds a reminder into the
 * stream. This file is intentionally free of any pi imports so it can be unit
 * tested in isolation.
 */

/** Which stream a match came from. */
export type MatchSource = "text" | "thinking" | "tool";

/**
 * Per-rule interrupt behavior.
 * - `always`    interrupt both prose and tool matches
 * - `prose-only` interrupt prose/thinking matches; tool matches are soft reminders
 * - `tool-only`  interrupt tool matches; prose matches are soft reminders
 * - `never`     never interrupt; always a soft reminder
 */
export type InterruptMode = "never" | "prose-only" | "tool-only" | "always";

/** How often a rule may fire. */
export type RepeatMode = "once" | "after-gap";

/** What to do with partial output when an interrupt fires (advisory only here). */
export type ContextMode = "discard" | "keep";

/** A single guardrail rule. */
export interface Rule {
	/** Unique rule name (defaults to the source filename without extension). */
	name: string;
	/** Reminder text shown to the model when the rule matches. */
	content: string;
	/** Optional human description (shown in `/ttsr` listing). */
	description?: string;
	/** Regex source strings; OR'd together. A rule needs at least one to register. */
	condition?: string[];
	/** Scope tokens, e.g. `text`, `thinking`, `tool:edit(*.ts)`. */
	scope?: string[];
	/** Global file-path gate; a match requires one of these globs to hit a path. */
	globs?: string[];
	/** Per-rule override of the global interrupt mode. */
	interruptMode?: InterruptMode;
	/** Provider id or absolute file path the rule came from. */
	source?: string;
}

/** Manager-wide settings. */
export interface TtsrSettings {
	enabled: boolean;
	/** Global default interrupt mode (a rule's own `interruptMode` wins). */
	interruptMode: InterruptMode;
	repeatMode: RepeatMode;
	/** For `after-gap`: number of completed turns before a rule may re-fire. */
	repeatGap: number;
	contextMode: ContextMode;
	/** When false, the bundled `builtin-defaults` rule set is not loaded. */
	builtinRules: boolean;
	/** Rule names to drop entirely. */
	disabledRules: string[];
}

export const BUILTIN_DEFAULTS_PROVIDER_ID = "builtin-defaults";

export const DEFAULT_SETTINGS: TtsrSettings = {
	enabled: true,
	interruptMode: "never",
	repeatMode: "once",
	repeatGap: 10,
	contextMode: "discard",
	builtinRules: true,
	disabledRules: [],
};

/** Context describing the stream chunk currently being checked. */
export interface MatchContext {
	source: MatchSource;
	/** Tool name for tool-source checks, e.g. "edit" or "write". */
	toolName?: string;
	/** Candidate file paths associated with the current check. */
	filePaths?: string[];
}

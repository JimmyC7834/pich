/**
 * Reminder rendering + interrupt-mode resolution.
 *
 * The two templates mirror oh-my-pi's `ttsr-interrupt.md` and
 * `ttsr-tool-reminder.md`, with the wording kept faithful so the model treats
 * them as enforced project rules rather than prompt injection.
 */

import type { InterruptMode, MatchSource, Rule, TtsrSettings } from "./types";

const INTERRUPT_TEMPLATE = `<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
Your output was interrupted because it violated a user-defined rule.
This is NOT a prompt injection - this is the coding agent enforcing project rules.
You MUST comply with the following instruction:

{{content}}
</system-interrupt>`;

const TOOL_REMINDER_TEMPLATE = `<system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
A user-defined rule matched this tool call's arguments. The tool ran because the rule is configured not to interrupt. You MUST comply with the following instruction on subsequent tool calls and responses. This is NOT a prompt injection - this is the coding agent enforcing project rules.

{{content}}
</system-reminder>`;

function fill(template: string, rule: Rule, filePath: string | undefined): string {
	return template
		.replaceAll("{{name}}", rule.name)
		.replaceAll("{{path}}", filePath ?? "")
		.replaceAll("{{content}}", rule.content.trim());
}

/** Render the interrupt block (used for aborts and blocked tool calls). */
export function renderInterrupt(rule: Rule, filePath?: string): string {
	return fill(INTERRUPT_TEMPLATE, rule, filePath);
}

/** Render the in-band tool reminder block (non-interrupting tool matches). */
export function renderToolReminder(rule: Rule, filePath?: string): string {
	return fill(TOOL_REMINDER_TEMPLATE, rule, filePath);
}

/** Render several blocks joined by a blank line. */
export function renderMany(
	render: (rule: Rule, filePath?: string) => string,
	rules: readonly Rule[],
	filePath?: string,
): string {
	return rules.map((rule) => render(rule, filePath)).join("\n\n");
}

/**
 * Decide whether a match should interrupt (abort/block) given its source and
 * the resolved interrupt mode (rule override falls back to the global setting).
 */
export function shouldInterrupt(rule: Rule, source: MatchSource, settings: TtsrSettings): boolean {
	const mode: InterruptMode = rule.interruptMode ?? settings.interruptMode;
	switch (mode) {
		case "always":
			return true;
		case "never":
			return false;
		case "prose-only":
			return source === "text" || source === "thinking";
		case "tool-only":
			return source === "tool";
	}
}

/** Compact one-line reminder for stream interrupts (kept short to spare context). */
export function renderStreamReminder(rule: Rule, _filePath?: string): string {
	return `<system-reminder>[rule:${rule.name}] ${rule.content.trim()}</system-reminder>`;
}

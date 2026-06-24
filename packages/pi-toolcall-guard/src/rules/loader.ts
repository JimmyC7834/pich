/**
 * Rule discovery + normalization.
 *
 * Loads bundled `builtin-defaults` rules (shipped as `.md` files next to this
 * package) and project rules from `<cwd>/.pi/guard-rules/*.md`, converting each
 * file's frontmatter into a {@link Rule}. Project rules override builtins of the
 * same name (project loaded last, first-wins dedupe by name).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuleFile } from "./frontmatter";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type InterruptMode, type Rule } from "./types";

const VALID_INTERRUPT_MODES: ReadonlySet<string> = new Set(["never", "prose-only", "tool-only", "always"]);

function toArray(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const arr = Array.isArray(value) ? value : [value];
	const cleaned = arr.map((v) => v.trim()).filter((v) => v.length > 0);
	return cleaned.length > 0 ? cleaned : undefined;
}

/** Split a scope string on top-level commas (parentheses are not separators). */
export function splitScopeTokens(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let depth = 0;
	for (const char of value) {
		if (char === "(") {
			depth++;
			current += char;
		} else if (char === ")") {
			depth = Math.max(0, depth - 1);
			current += char;
		} else if (char === "," && depth === 0) {
			if (current.trim().length > 0) {
				tokens.push(current.trim());
			}
			current = "";
		} else {
			current += char;
		}
	}
	if (current.trim().length > 0) {
		tokens.push(current.trim());
	}
	return tokens;
}

function normalizeScope(value: string | string[] | undefined): string[] | undefined {
	const arr = toArray(value);
	if (!arr) {
		return undefined;
	}
	const tokens = arr.flatMap(splitScopeTokens).filter((t) => t.length > 0);
	return tokens.length > 0 ? [...new Set(tokens)] : undefined;
}

function ruleFromFile(filePath: string, source: string): Rule | undefined {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseRuleFile(text);
	const fm = frontmatter as Record<string, string | string[] | undefined>;
	const name = (typeof fm.name === "string" && fm.name.trim()) || path.basename(filePath, ".md");
	const rawInterrupt = typeof fm.interruptMode === "string" ? fm.interruptMode.trim() : undefined;
	const interruptMode = rawInterrupt && VALID_INTERRUPT_MODES.has(rawInterrupt) ? (rawInterrupt as InterruptMode) : undefined;

	return {
		name,
		content: body,
		description: typeof fm.description === "string" ? fm.description : undefined,
		condition: toArray(fm.condition),
		scope: normalizeScope(fm.scope),
		globs: toArray(fm.globs),
		interruptMode,
		source,
	};
}

function loadRulesFromDir(dir: string, source: string): Rule[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const rules: Rule[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) {
			continue;
		}
		const rule = ruleFromFile(path.join(dir, entry), source);
		if (rule) {
			rules.push(rule);
		}
	}
	return rules;
}

/** Absolute path to the bundled builtin rules directory. */
export function builtinRulesDir(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "..", "..", "builtin-rules");
}

export interface LoadRulesOptions {
	cwd: string;
	builtinRules: boolean;
	disabledRules: readonly string[];
	/** Override the project rules directory (default `<cwd>/.pi/guard-rules`). */
	projectRulesDir?: string;
}

/**
 * Load rules: builtins first (lowest priority), then project rules. Disabled
 * names are dropped; duplicate names keep the first occurrence (project wins
 * because project rules are appended and dedupe is last-wins here).
 */
export function loadRules(options: LoadRulesOptions): Rule[] {
	const disabled = new Set(options.disabledRules.map((n) => n.trim()).filter((n) => n.length > 0));
	const collected: Rule[] = [];
	if (options.builtinRules) {
		collected.push(...loadRulesFromDir(builtinRulesDir(), BUILTIN_DEFAULTS_PROVIDER_ID));
	}
	const projectDir = options.projectRulesDir ?? path.join(options.cwd, ".pi", "guard-rules");
	collected.push(...loadRulesFromDir(projectDir, projectDir));

	// Last-wins dedupe by name so project rules override builtins.
	const byName = new Map<string, Rule>();
	for (const rule of collected) {
		if (disabled.has(rule.name)) {
			continue;
		}
		byName.set(rule.name, rule);
	}
	return [...byName.values()];
}

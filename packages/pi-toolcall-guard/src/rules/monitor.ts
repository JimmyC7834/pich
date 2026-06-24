/**
 * RuleMonitor — the pure matcher.
 *
 * A passive object: feed it a content snapshot plus a {@link MatchContext} and
 * it returns the rules that match (after scope, path-glob, regex, and repeat
 * gates). It owns no side effects — interrupting, injecting, and persistence
 * all live in the driver. Regex-only by design; ast-grep conditions are out of
 * scope for this lightweight port.
 */

import { matchGlob } from "./glob";
import type { MatchContext, Rule, TtsrSettings } from "./types";

interface ToolScope {
	toolName?: string;
	pathGlob?: string;
}

interface RuleScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

interface RuleEntry {
	rule: Rule;
	conditions: RegExp[];
	scope: RuleScope;
	globalGlobs?: string[];
}

const DEFAULT_SCOPE: RuleScope = {
	allowText: true,
	allowThinking: false,
	allowAnyTool: true,
	toolScopes: [],
};

/** Parse a single scope token such as `tool:edit(*.ts)` or `edit(*.ts)`. */
function parseToolScopeToken(token: string): ToolScope | undefined {
	const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
		token,
	);
	if (!match?.groups) {
		return undefined;
	}
	const { prefix, tool, bare, path } = match.groups;
	const toolName = (tool ?? (prefix !== undefined ? undefined : bare))?.trim().toLowerCase();
	const pathGlob = path?.trim();
	return pathGlob ? { toolName, pathGlob } : { toolName };
}

export class RuleMonitor {
	readonly #settings: TtsrSettings;
	readonly #rules = new Map<string, RuleEntry>();
	/** rule name -> message count when it was last injected. */
	readonly #injected = new Map<string, number>();
	#messageCount = 0;

	constructor(settings: TtsrSettings) {
		this.#settings = settings;
	}

	#compileConditions(rule: Rule): RegExp[] {
		const compiled: RegExp[] = [];
		for (const pattern of rule.condition ?? []) {
			try {
				compiled.push(new RegExp(pattern));
			} catch {
				// Invalid regex: skip this condition, keep the rest.
			}
		}
		return compiled;
	}

	#buildScope(rule: Rule): RuleScope {
		if (!rule.scope || rule.scope.length === 0) {
			return { ...DEFAULT_SCOPE, toolScopes: [] };
		}
		const scope: RuleScope = {
			allowText: false,
			allowThinking: false,
			allowAnyTool: false,
			toolScopes: [],
		};
		for (const raw of rule.scope) {
			const token = raw.trim();
			if (token.length === 0) {
				continue;
			}
			const normalized = token.toLowerCase();
			if (normalized === "text") {
				scope.allowText = true;
				continue;
			}
			if (normalized === "thinking") {
				scope.allowThinking = true;
				continue;
			}
			if (normalized === "tool" || normalized === "toolcall") {
				scope.allowAnyTool = true;
				continue;
			}
			const toolScope = parseToolScopeToken(token);
			if (!toolScope) {
				continue;
			}
			if (!toolScope.toolName && !toolScope.pathGlob) {
				scope.allowAnyTool = true;
				continue;
			}
			scope.toolScopes.push(toolScope);
		}
		return scope;
	}

	#hasReachableScope(scope: RuleScope): boolean {
		return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
	}

	#canTrigger(name: string): boolean {
		const last = this.#injected.get(name);
		if (last === undefined) {
			return true;
		}
		if (this.#settings.repeatMode === "once") {
			return false;
		}
		return this.#messageCount - last >= this.#settings.repeatGap;
	}

	#matchesScope(entry: RuleEntry, context: MatchContext): boolean {
		if (context.source === "text") {
			return entry.scope.allowText;
		}
		if (context.source === "thinking") {
			return entry.scope.allowThinking;
		}
		if (entry.scope.allowAnyTool) {
			return true;
		}
		const toolName = context.toolName?.trim().toLowerCase();
		for (const toolScope of entry.scope.toolScopes) {
			if (toolScope.toolName && toolScope.toolName !== toolName) {
				continue;
			}
			if (toolScope.pathGlob && !matchGlob(toolScope.pathGlob, context.filePaths)) {
				continue;
			}
			return true;
		}
		return false;
	}

	#matchesGlobalPaths(entry: RuleEntry, context: MatchContext): boolean {
		if (!entry.globalGlobs || entry.globalGlobs.length === 0) {
			return true;
		}
		return entry.globalGlobs.some((glob) => matchGlob(glob, context.filePaths));
	}

	#matchesCondition(entry: RuleEntry, content: string): boolean {
		for (const condition of entry.conditions) {
			condition.lastIndex = 0;
			if (condition.test(content)) {
				return true;
			}
		}
		return false;
	}

	/** Register a rule. Returns false when it is rejected (disabled, no usable
	 * condition, duplicate name, or unreachable scope). */
	addRule(rule: Rule): boolean {
		if (!this.#settings.enabled || this.#rules.has(rule.name)) {
			return false;
		}
		const conditions = this.#compileConditions(rule);
		if (conditions.length === 0) {
			return false;
		}
		const scope = this.#buildScope(rule);
		if (!this.#hasReachableScope(scope)) {
			return false;
		}
		const globalGlobs = rule.globs?.map((g) => g.trim()).filter((g) => g.length > 0);
		this.#rules.set(rule.name, {
			rule,
			conditions,
			scope,
			globalGlobs: globalGlobs && globalGlobs.length > 0 ? globalGlobs : undefined,
		});
		return true;
	}

	/** Return all rules matching `content` in the given context. */
	check(content: string, context: MatchContext): Rule[] {
		if (!this.#settings.enabled || content.length === 0) {
			return [];
		}
		const matches: Rule[] = [];
		for (const [name, entry] of this.#rules) {
			if (!this.#canTrigger(name)) {
				continue;
			}
			if (!this.#matchesScope(entry, context)) {
				continue;
			}
			if (!this.#matchesGlobalPaths(entry, context)) {
				continue;
			}
			if (!this.#matchesCondition(entry, content)) {
				continue;
			}
			matches.push(entry.rule);
		}
		return matches;
	}

	markInjected(rules: readonly Rule[]): void {
		for (const rule of rules) {
			this.#injected.set(rule.name, this.#messageCount);
		}
	}

	restoreInjected(names: readonly string[]): void {
		for (const name of names) {
			if (!this.#injected.has(name)) {
				this.#injected.set(name, 0);
			}
		}
	}

	getInjectedRuleNames(): string[] {
		return [...this.#injected.keys()];
	}

	incrementMessageCount(): void {
		this.#messageCount++;
	}

	hasRules(): boolean {
		return this.#settings.enabled && this.#rules.size > 0;
	}

	getRules(): Rule[] {
		return [...this.#rules.values()].map((entry) => entry.rule);
	}

	clearRules(): void {
		this.#rules.clear();
	}
}

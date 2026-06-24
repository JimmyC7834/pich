# Guard Rule Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a regex content-rule engine to `pi-toolcall-guard` that inspects `edit`/`write`/`bash` tool arguments and either blocks the call or folds a `<system-reminder>` into the result, with rules loaded from bundled defaults plus `<cwd>/.pi/guard-rules/*.md`.

**Architecture:** Port the *pure* matcher modules from the pi-ttsr spec (glob, frontmatter, types, monitor, render, extract, loader) into `pi-toolcall-guard/src/rules/`, wrap them in a thin `RuleEngine`, and call it from the guard's *existing* `tool_call` and `tool_result` handlers. Tool-path only — no prose interruption, no `message_update`/`turn_*` subscriptions, no cross-session persistence. Reminder is the default action; a rule opts into blocking with `interruptMode: always`.

**Tech Stack:** TypeScript (jiti, no build step), vitest, Node `fs`/`path`/`url`. Source of truth for the ported modules: the pi-ttsr spec at `C:\Users\c7834\Downloads\text 2.txt`, Appendix A.

## Global Constraints

- All new code lives under `agent/extensions/pi-toolcall-guard/`. Do not create a new extension.
- **Relative imports are extensionless** to match the existing guard (`import { Metrics } from "./src/metrics"`). The pi-ttsr spec uses `./x.ts` imports — when you copy a file, rewrite every `from "./y.ts"` to `from "./y"`.
- **Do not subscribe to** `message_update`, `message_end`, `turn_start`, `turn_end`, or `session_start`. Do not call `pi.appendEntry`. The pi-ttsr `driver.ts` and its prose/persistence handlers are **not** ported.
- **Reminder is the default.** Set `DEFAULT_SETTINGS.interruptMode = "never"`. A rule blocks only when its own frontmatter sets `interruptMode: always` (or `tool-only`).
- Never regress the existing guard tests. After every task, the full guard suite (`npx vitest run`) stays green.
- Git: path-scoped `git add` only (never `git add -A` / `git add .` — the repo carries unrelated dirty files). LF line endings. Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Run targeted tests with `npx vitest run <path>` from `agent/extensions/pi-toolcall-guard/`.

---

### Task 1: Port the foundation modules (types, glob, frontmatter)

Three pure, dependency-light modules. `types.ts` carries the data shapes; `glob.ts` and `frontmatter.ts` are leaf utilities with their own tests in the spec.

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/rules/types.ts`
- Create: `agent/extensions/pi-toolcall-guard/src/rules/glob.ts`
- Create: `agent/extensions/pi-toolcall-guard/src/rules/frontmatter.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/rules/glob.test.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/rules/frontmatter.test.ts`

**Interfaces:**
- Produces: `Rule` (`{ name: string; content: string; description?: string; condition?: string[]; scope?: string[]; globs?: string[]; interruptMode?: InterruptMode; source?: string }`), `TtsrSettings`, `MatchSource = "text" | "thinking" | "tool"`, `InterruptMode = "never" | "prose-only" | "tool-only" | "always"`, `MatchContext = { source: MatchSource; toolName?: string; filePaths?: string[] }`, `DEFAULT_SETTINGS: TtsrSettings`, `BUILTIN_DEFAULTS_PROVIDER_ID`.
- Produces: `matchGlob(glob: string, paths: readonly string[] | undefined): boolean`, `expandBraces`, `globToRegExp`.
- Produces: `parseRuleFile(text: string): { frontmatter: Record<string, string | string[]>; body: string }`.

- [ ] **Step 1: Copy `glob.ts` and `frontmatter.ts` verbatim from the spec**

Copy `src/glob.ts` and `src/frontmatter.ts` from the pi-ttsr spec Appendix A into `src/rules/`. They have no relative imports, so no import rewriting is needed. Do not change any logic.

- [ ] **Step 2: Copy `rule-types.ts` as `types.ts` with one change**

Copy `src/rule-types.ts` from the spec into `src/rules/types.ts`. Change exactly one value — the default interrupt mode — so reminders are the default:

```ts
export const DEFAULT_SETTINGS: TtsrSettings = {
	enabled: true,
	interruptMode: "never", // CHANGED from "always": reminder-by-default; rules opt into blocking
	repeatMode: "once",
	repeatGap: 10,
	contextMode: "discard",
	builtinRules: true,
	disabledRules: [],
};
```

- [ ] **Step 3: Copy the glob and frontmatter tests, fixing import paths**

Copy `test/glob.test.ts` and `test/frontmatter.test.ts` from the spec into `test/rules/`. Rewrite their imports to point at the new locations and drop the `.ts` extension:

```ts
// test/rules/glob.test.ts
import { expandBraces, globToRegExp, matchGlob } from "../../src/rules/glob";
// test/rules/frontmatter.test.ts
import { parseRuleFile } from "../../src/rules/frontmatter";
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/rules/glob.test.ts test/rules/frontmatter.test.ts`
Expected: PASS (8 glob assertions + 5 frontmatter assertions).

- [ ] **Step 5: Run the full guard suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — the existing `test/*.test.ts` plus the two new files.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/rules/types.ts \
        agent/extensions/pi-toolcall-guard/src/rules/glob.ts \
        agent/extensions/pi-toolcall-guard/src/rules/frontmatter.ts \
        agent/extensions/pi-toolcall-guard/test/rules/glob.test.ts \
        agent/extensions/pi-toolcall-guard/test/rules/frontmatter.test.ts
git commit -m "feat(guard): port glob/frontmatter/types matcher foundation"
```

---

### Task 2: Port the matcher and renderer (monitor, render)

`RuleMonitor` is the pure scope/glob/regex matcher; `render.ts` holds the two output templates and `shouldInterrupt`. Both come over almost verbatim.

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/rules/monitor.ts`
- Create: `agent/extensions/pi-toolcall-guard/src/rules/render.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/rules/monitor.test.ts`

**Interfaces:**
- Consumes: `Rule`, `TtsrSettings`, `MatchContext`, `MatchSource`, `InterruptMode` from `./types`; `matchGlob` from `./glob`.
- Produces: `class RuleMonitor` with `addRule(rule: Rule): boolean`, `check(content: string, ctx: MatchContext): Rule[]`, `hasRules(): boolean`, `getRules(): Rule[]`, `clearRules(): void` (the `markInjected`/`restoreInjected`/`incrementMessageCount` methods come along but are never called by the engine).
- Produces: `renderInterrupt(rule, filePath?)`, `renderToolReminder(rule, filePath?)`, `renderMany(render, rules, filePath?)`, `shouldInterrupt(rule, source, settings): boolean`.

- [ ] **Step 1: Copy `rule-monitor.ts` as `monitor.ts`, fixing imports**

Copy `src/rule-monitor.ts` from the spec into `src/rules/monitor.ts`. Rewrite the two imports:

```ts
import { matchGlob } from "./glob";
import type { MatchContext, Rule, TtsrSettings } from "./types";
```

Leave all logic untouched, including `markInjected`/`restoreInjected`/`incrementMessageCount` — they are dormant (the engine never calls them, so every matching tool call re-fires, which is the intended behavior).

- [ ] **Step 2: Copy `render.ts` verbatim, fixing the import**

Copy `src/render.ts` from the spec into `src/rules/render.ts`. Rewrite the one import:

```ts
import type { InterruptMode, MatchSource, Rule, TtsrSettings } from "./types";
```

- [ ] **Step 3: Copy the monitor tests, fixing imports**

Copy `test/rule-monitor.test.ts` from the spec into `test/rules/monitor.test.ts`. Rewrite its imports:

```ts
import { RuleMonitor } from "../../src/rules/monitor";
import { DEFAULT_SETTINGS, type Rule, type TtsrSettings } from "../../src/rules/types";
```

Note: the spec's monitor tests call `markInjected` directly to exercise repeat policy — keep them; they verify the monitor in isolation even though the engine won't use those methods.

- [ ] **Step 4: Run the monitor tests**

Run: `npx vitest run test/rules/monitor.test.ts`
Expected: PASS (registration, scope, global-glob, and repeat-policy assertions).

- [ ] **Step 5: Add a render smoke test asserting the reminder-default**

Append to `test/rules/monitor.test.ts` a check that `shouldInterrupt` honors the new default (a rule with no `interruptMode` is soft under `DEFAULT_SETTINGS`):

```ts
import { shouldInterrupt } from "../../src/rules/render";

describe("shouldInterrupt — reminder default", () => {
	it("a rule with no interruptMode is soft under DEFAULT_SETTINGS", () => {
		const rule: Rule = { name: "x", content: "c", condition: ["foo"] };
		expect(shouldInterrupt(rule, "tool", DEFAULT_SETTINGS)).toBe(false);
	});
	it("a rule with interruptMode 'always' blocks", () => {
		const rule: Rule = { name: "x", content: "c", condition: ["foo"], interruptMode: "always" };
		expect(shouldInterrupt(rule, "tool", DEFAULT_SETTINGS)).toBe(true);
	});
});
```

- [ ] **Step 6: Run tests and the full suite**

Run: `npx vitest run test/rules/monitor.test.ts` then `npx vitest run`
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/rules/monitor.ts \
        agent/extensions/pi-toolcall-guard/src/rules/render.ts \
        agent/extensions/pi-toolcall-guard/test/rules/monitor.test.ts
git commit -m "feat(guard): port RuleMonitor matcher and reminder/interrupt renderer"
```

---

### Task 3: Port `extract` WITH the hashline `lines` fix

The pi-ttsr extractor only reads `newText`/`new_string` from edits. Your hashline `edit` tool (`agent/extensions/pi-hashline-edit/src/edit.ts:63-92`) puts replacement content for its primary ops (`replace`/`append`/`prepend`) in a `lines: string[]` field; `newText` exists only for the `replace_text` op. Without reading `lines`, every content rule silently no-ops on the dominant edit path. This task ports `extract.ts` and adds `lines` handling.

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/rules/extract.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/rules/extract.test.ts`

**Interfaces:**
- Produces: `extractToolSnapshot(toolName: string, input: Record<string, unknown> | undefined): { snapshot: string; filePaths: string[] }`, `dedupeByName<T extends { name: string }>(rules: readonly T[]): T[]`, `extractProse` (ported but unused by the engine).

- [ ] **Step 1: Write the failing test for the hashline `lines` dialect**

Create `test/rules/extract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractToolSnapshot } from "../../src/rules/extract";

describe("extractToolSnapshot — hashline edit", () => {
	it("reads `lines` for replace/append/prepend ops", () => {
		const input = {
			path: "src/a.ts",
			edits: [{ op: "replace", pos: "12#abcd", lines: ["const x: any = 1;"] }],
		};
		const { snapshot, filePaths } = extractToolSnapshot("edit", input);
		expect(snapshot).toContain(": any");
		expect(filePaths).toEqual(["src/a.ts"]);
	});

	it("still reads newText for replace_text ops", () => {
		const input = {
			path: "src/a.ts",
			edits: [{ op: "replace_text", oldText: "x", newText: "y as any" }],
		};
		expect(extractToolSnapshot("edit", input).snapshot).toContain("as any");
	});

	it("reads content for write and command for bash", () => {
		expect(extractToolSnapshot("write", { path: "a.ts", content: "Box::leak" }).snapshot).toContain("Box::leak");
		expect(extractToolSnapshot("bash", { command: "git add -A" }).snapshot).toBe("git add -A");
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/rules/extract.test.ts`
Expected: FAIL — cannot resolve `../../src/rules/extract`.

- [ ] **Step 3: Create `extract.ts` from the spec with the `lines` fix**

Copy `src/extract.ts` from the spec into `src/rules/extract.ts` verbatim, then replace the `edit` branch of `extractToolSnapshot` with this version (the only change is joining `lines` alongside `newText`):

```ts
	if (toolName === "edit") {
		const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : [];
		const snapshot = edits
			.map((edit) => {
				// hashline replace_text dialect
				const replaced = asString(edit.newText) ?? asString(edit.new_string) ?? "";
				// hashline replace/append/prepend dialect: content lives in `lines`
				const lines = Array.isArray(edit.lines)
					? (edit.lines as unknown[]).filter((l): l is string => typeof l === "string").join("\n")
					: "";
				return [replaced, lines].filter((s) => s.length > 0).join("\n");
			})
			.join("\n");
		return { snapshot, filePaths };
	}
```

There are no relative imports to rewrite in `extract.ts`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run test/rules/extract.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/rules/extract.ts \
        agent/extensions/pi-toolcall-guard/test/rules/extract.test.ts
git commit -m "feat(guard): port tool-snapshot extractor with hashline lines support"
```

---

### Task 4: Port the loader and ship the bundled rules

Loads `.md` rules from a bundled `builtin-rules/` directory plus `<cwd>/.pi/guard-rules/`. Ships two high-confidence blocking rules that encode this project's standing constraints (no secrets in files, no `git add -A`).

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/rules/loader.ts`
- Create: `agent/extensions/pi-toolcall-guard/builtin-rules/secret-in-file.md`
- Create: `agent/extensions/pi-toolcall-guard/builtin-rules/no-git-add-all.md`
- Test: `agent/extensions/pi-toolcall-guard/test/rules/loader.test.ts`

**Interfaces:**
- Consumes: `parseRuleFile` from `./frontmatter`; `Rule`, `InterruptMode`, `BUILTIN_DEFAULTS_PROVIDER_ID` from `./types`.
- Produces: `loadRules(options: { cwd: string; builtinRules: boolean; disabledRules: readonly string[]; projectRulesDir?: string }): Rule[]`, `splitScopeTokens(value: string): string[]`, `builtinRulesDir(): string`.

- [ ] **Step 1: Author the two bundled rule files**

Create `builtin-rules/secret-in-file.md`:

```markdown
---
description: Block writing obvious secrets or private keys into files
condition:
  - "AKIA[0-9A-Z]{16}"
  - "-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----"
  - "xox[baprs]-[0-9A-Za-z]{10,}"
scope: "tool:write, tool:edit"
interruptMode: always
---

Do not write secrets, API keys, or private keys into source or config files. Load them from an environment variable or an untracked local file at runtime instead. Committing a credential — even briefly — leaks it.
```

Create `builtin-rules/no-git-add-all.md`:

```markdown
---
description: Block `git add -A` / `git add .` — stage paths explicitly
condition:
  - "git\\s+add\\s+-A\\b"
  - "git\\s+add\\s+--all\\b"
  - "git\\s+add\\s+\\.(\\s|$)"
scope: "tool:bash"
interruptMode: always
---

Never stage everything with `git add -A`, `git add --all`, or `git add .`. This repository carries unrelated dirty and untracked files; stage only the exact paths you changed, by name.
```

- [ ] **Step 2: Write the failing loader test**

Create `test/rules/loader.test.ts`:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules, splitScopeTokens } from "../../src/rules/loader";
import { RuleMonitor } from "../../src/rules/monitor";
import { DEFAULT_SETTINGS } from "../../src/rules/types";

describe("splitScopeTokens", () => {
	it("splits top-level commas but not commas inside parens", () => {
		expect(splitScopeTokens("tool:edit(*.{ts,tsx}), tool:write(*.ts)")).toEqual([
			"tool:edit(*.{ts,tsx})",
			"tool:write(*.ts)",
		]);
	});
});

describe("loadRules — bundled defaults", () => {
	it("loads the two bundled rules and they register", () => {
		const rules = loadRules({ cwd: os.tmpdir(), builtinRules: true, disabledRules: [] });
		expect(rules.some((r) => r.name === "secret-in-file")).toBe(true);
		expect(rules.some((r) => r.name === "no-git-add-all")).toBe(true);
		const monitor = new RuleMonitor({ ...DEFAULT_SETTINGS });
		let registered = 0;
		for (const rule of rules) if (monitor.addRule(rule)) registered++;
		expect(registered).toBe(rules.length);
	});

	it("the git-add rule blocks `git add -A` and stays soft elsewhere", () => {
		const rules = loadRules({ cwd: os.tmpdir(), builtinRules: true, disabledRules: [] });
		const monitor = new RuleMonitor({ ...DEFAULT_SETTINGS });
		for (const rule of rules) monitor.addRule(rule);
		expect(monitor.check("git add -A", { source: "tool", toolName: "bash" }).map((r) => r.name)).toContain("no-git-add-all");
		expect(monitor.check("git add src/file.ts", { source: "tool", toolName: "bash" })).toEqual([]);
	});

	it("honors disabledRules and skips builtins when builtinRules is false", () => {
		expect(loadRules({ cwd: os.tmpdir(), builtinRules: true, disabledRules: ["no-git-add-all"] }).some((r) => r.name === "no-git-add-all")).toBe(false);
		expect(loadRules({ cwd: os.tmpdir(), builtinRules: false, disabledRules: [] })).toEqual([]);
	});
});

describe("loadRules — project rules", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-rules-"));
		fs.mkdirSync(path.join(dir, ".pi", "guard-rules"), { recursive: true });
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("loads a project rule from <cwd>/.pi/guard-rules", () => {
		fs.writeFileSync(
			path.join(dir, ".pi", "guard-rules", "no-todo.md"),
			['---', 'description: no TODO', 'condition: "TODO"', 'scope: "tool:edit"', '---', 'No TODOs.'].join("\n"),
		);
		const rules = loadRules({ cwd: dir, builtinRules: false, disabledRules: [] });
		expect(rules.map((r) => r.name)).toContain("no-todo");
	});
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run test/rules/loader.test.ts`
Expected: FAIL — cannot resolve `../../src/rules/loader`.

- [ ] **Step 4: Create `loader.ts` from the spec with two path changes**

Copy `src/rule-loader.ts` from the spec into `src/rules/loader.ts`. Rewrite the imports (extensionless):

```ts
import { parseRuleFile } from "./frontmatter";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type InterruptMode, type Rule } from "./types";
```

Then make exactly two changes for the new package layout:

```ts
// builtin-rules lives at the package root; loader.ts is at src/rules/, so go up two levels.
export function builtinRulesDir(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "..", "..", "builtin-rules");
}
```

```ts
// project rules directory default: <cwd>/.pi/guard-rules (was .pi/ttsr-rules)
const projectDir = options.projectRulesDir ?? path.join(options.cwd, ".pi", "guard-rules");
```

- [ ] **Step 5: Run the loader test, then the full suite**

Run: `npx vitest run test/rules/loader.test.ts`
Expected: PASS.
Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/rules/loader.ts \
        agent/extensions/pi-toolcall-guard/builtin-rules/secret-in-file.md \
        agent/extensions/pi-toolcall-guard/builtin-rules/no-git-add-all.md \
        agent/extensions/pi-toolcall-guard/test/rules/loader.test.ts
git commit -m "feat(guard): rule loader + bundled secret/git-add-all rules"
```

---

### Task 5: The `RuleEngine` glue

A thin class that builds a `RuleMonitor` from loaded rules and turns a tool call into a decision: block (with rendered interrupt text) or remind (with rendered reminder text), or nothing.

**Files:**
- Create: `agent/extensions/pi-toolcall-guard/src/rules/engine.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/rules/engine.test.ts`

**Interfaces:**
- Consumes: `extractToolSnapshot`, `dedupeByName` from `./extract`; `renderInterrupt`, `renderToolReminder`, `renderMany`, `shouldInterrupt` from `./render`; `RuleMonitor` from `./monitor`; `Rule`, `TtsrSettings` from `./types`.
- Produces: `interface RuleDecision { action: "block" | "remind"; text: string; ruleNames: string[] }` and `class RuleEngine` with `constructor(rules: readonly Rule[], settings: TtsrSettings)`, `hasRules(): boolean`, `checkToolCall(toolName: string, input: Record<string, unknown> | undefined): RuleDecision | undefined`.

- [ ] **Step 1: Write the failing engine test**

Create `test/rules/engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RuleEngine } from "../../src/rules/engine";
import { DEFAULT_SETTINGS, type Rule } from "../../src/rules/types";

const blockRule: Rule = { name: "no-leak", content: "no Box::leak", condition: ["Box::leak"], scope: ["tool:write"], interruptMode: "always" };
const softRule: Rule = { name: "no-any", content: "no any", condition: [": any"], scope: ["tool:edit(*.ts)"] };

describe("RuleEngine.checkToolCall", () => {
	it("blocks a write that trips an always-rule", () => {
		const engine = new RuleEngine([blockRule], DEFAULT_SETTINGS);
		const d = engine.checkToolCall("write", { path: "a.rs", content: "Box::leak(x)" });
		expect(d?.action).toBe("block");
		expect(d?.text).toContain("<system-interrupt");
		expect(d?.ruleNames).toEqual(["no-leak"]);
	});

	it("reminds (does not block) on a default-mode edit match via hashline lines", () => {
		const engine = new RuleEngine([softRule], DEFAULT_SETTINGS);
		const d = engine.checkToolCall("edit", { path: "a.ts", edits: [{ op: "replace", pos: "1#aa", lines: ["let v: any;"] }] });
		expect(d?.action).toBe("remind");
		expect(d?.text).toContain("<system-reminder");
	});

	it("returns undefined for a clean call and when there are no rules", () => {
		expect(new RuleEngine([softRule], DEFAULT_SETTINGS).checkToolCall("edit", { path: "a.ts", edits: [{ op: "replace", pos: "1#aa", lines: ["let v: number;"] }] })).toBeUndefined();
		expect(new RuleEngine([], DEFAULT_SETTINGS).checkToolCall("write", { path: "a.rs", content: "Box::leak(x)" })).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/rules/engine.test.ts`
Expected: FAIL — cannot resolve `../../src/rules/engine`.

- [ ] **Step 3: Implement `engine.ts`**

```ts
import { dedupeByName, extractToolSnapshot } from "./extract";
import { RuleMonitor } from "./monitor";
import { renderInterrupt, renderMany, renderToolReminder, shouldInterrupt } from "./render";
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
}
```

- [ ] **Step 4: Run the engine test, then the full suite**

Run: `npx vitest run test/rules/engine.test.ts`
Expected: PASS.
Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/rules/engine.ts \
        agent/extensions/pi-toolcall-guard/test/rules/engine.test.ts
git commit -m "feat(guard): RuleEngine block/remind decision wrapper"
```

---

### Task 6: Wire the engine into the guard + add the `rule` metric

Add a `rule` event to the metrics union, then call the engine from the existing `tool_call`/`tool_result` handlers in `index.ts`. The engine runs for every tool after the existing nudge/preflight checks; a block returns immediately, a reminder is stashed and prepended to the successful result.

**Files:**
- Modify: `agent/extensions/pi-toolcall-guard/src/metrics.ts:3-7`
- Modify: `agent/extensions/pi-toolcall-guard/index.ts`
- Test: `agent/extensions/pi-toolcall-guard/test/integration.test.ts` (extend)

**Interfaces:**
- Consumes: `RuleEngine`, `RuleDecision` from `./src/rules/engine`; `loadRules` from `./src/rules/loader`; `DEFAULT_SETTINGS` from `./src/rules/types`.
- Produces: a new metrics variant `{ kind: "rule"; toolName: string; action: "block" | "remind"; rules: string }` consumed by Task 7's report.

- [ ] **Step 1: Add the `rule` variant to the metrics union**

In `src/metrics.ts`, extend the `GuardEvent` union (the existing block ends at line 7 with the `nudge` variant):

```ts
export type GuardEvent =
	| { kind: "preflight"; outcome: "normalized" | "block"; toolName: string }
	| { kind: "preflight_recovered"; toolName: string }
	| { kind: "enrich"; matched: boolean; rule?: string; toolName: string }
	| { kind: "nudge"; toolName: string; rule: string; tool: string }
	| { kind: "rule"; toolName: string; action: "block" | "remind"; rules: string };
```

- [ ] **Step 2: Write the failing integration tests**

Append to `test/integration.test.ts`. The existing `makePi` already supplies `getAllTools`; the engine loads bundled rules from the package's `builtin-rules/` dir on disk, so no extra fakery is needed. Use a `cwd` with no `.pi/guard-rules` so only the bundled rules apply.

```ts
it("blocks `git add -A` via a bundled rule and records a rule event", () => {
	const { pi, handlers } = makePi();
	register(pi);
	const res = handlers.tool_call(
		{ type: "tool_call", toolName: "bash", toolCallId: "r1", input: { command: "git add -A" } },
		{ cwd: dir },
	);
	expect(res.block).toBe(true);
	expect(res.reason).toContain("<system-interrupt");
	const log = readFileSync(join(dir, "metrics", ".pi-guard-metrics.jsonl"), "utf8");
	expect(log).toContain('"rule"');
	expect(log).toContain('"action":"block"');
});

it("prepends a reminder to a successful edit result for a project rule", () => {
	// project rule (soft by default) lives in <cwd>/.pi/guard-rules
	mkdirSync(join(dir, ".pi", "guard-rules"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "guard-rules", "no-todo.md"),
		['---', 'condition: "TODO"', 'scope: "tool:edit"', '---', 'No TODOs in code.'].join("\n"),
	);
	const { pi, handlers } = makePi();
	register(pi);
	const call = handlers.tool_call(
		{ type: "tool_call", toolName: "edit", toolCallId: "r2", input: { path: "a.ts", edits: [{ op: "replace", pos: "1#aa", lines: ["// TODO later"] }] } },
		{ cwd: dir },
	);
	expect(call).toBeUndefined(); // soft: not blocked
	const patch = handlers.tool_result({
		type: "tool_result", toolName: "edit", toolCallId: "r2", input: { path: "a.ts" },
		isError: false, content: [{ type: "text", text: "applied" }], details: undefined,
	});
	expect(patch.content[0].text).toContain("<system-reminder");
	expect(patch.content[1].text).toBe("applied");
});

it("does not prepend a reminder when the edit result is an error", () => {
	mkdirSync(join(dir, ".pi", "guard-rules"), { recursive: true });
	writeFileSync(join(dir, ".pi", "guard-rules", "no-todo.md"), ['---', 'condition: "TODO"', 'scope: "tool:edit"', '---', 'No TODOs.'].join("\n"));
	const { pi, handlers } = makePi();
	register(pi);
	handlers.tool_call(
		{ type: "tool_call", toolName: "edit", toolCallId: "r3", input: { path: "a.ts", edits: [{ op: "replace", pos: "1#aa", lines: ["// TODO"] }] } },
		{ cwd: dir },
	);
	const patch = handlers.tool_result({
		type: "tool_result", toolName: "edit", toolCallId: "r3", input: { path: "a.ts" },
		isError: true, content: [{ type: "text", text: "ENOENT" }], details: undefined,
	});
	// error path enriches; it must NOT carry a reminder block
	expect(patch?.content?.[0]?.text ?? "").not.toContain("<system-reminder");
});
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — engine not yet wired (no `"rule"` in the log; no reminder prepended).

- [ ] **Step 4: Add engine imports and lazy construction to `index.ts`**

After the existing imports (the last is `import { nudge } from "./src/nudge";`), add:

```ts
import { RuleEngine, type RuleDecision } from "./src/rules/engine";
import { loadRules } from "./src/rules/loader";
import { DEFAULT_SETTINGS } from "./src/rules/types";
```

Inside the factory, after the `toolExists` helper block (ends near line 44) and before `pi.on("tool_call", ...)`, add the lazy engine builder and the reminder stash:

```ts
	// Reminders pending application at tool_result, keyed by toolCallId.
	const pendingReminders = new Map<string, RuleDecision>();

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
```

- [ ] **Step 5: Restructure the `tool_call` handler so the engine runs for all tools**

Replace the body of the `pi.on("tool_call", ...)` handler (currently `index.ts:46-83`) with this. The change: the bash branch no longer `return`s early on a non-match, the preflight `normalized` branch no longer `return`s, and a single engine check runs at the end for every tool that wasn't already blocked.

```ts
	pi.on("tool_call", (event, ctx) => {
		try {
			const input = (event.input ?? {}) as Record<string, unknown>;

			// Native-tool nudge for bash (redirect cat/grep/sed to dedicated tools).
			if (event.toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
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
```

- [ ] **Step 6: Apply the stashed reminder in the `tool_result` handler**

Replace the body of `pi.on("tool_result", ...)` (currently `index.ts:85-99`) with this. A reminder is applied only on a successful result (the edit actually ran); on an error the stash is discarded and the existing enrich path runs unchanged.

```ts
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
```

- [ ] **Step 7: Run the integration tests, then the full suite**

Run: `npx vitest run test/integration.test.ts`
Expected: PASS — including the pre-existing nudge/preflight/enrich/recovery tests (confirm none regressed; the normalize-then-proceed test still returns `undefined` because no bundled rule matches a `read`).
Run: `npx vitest run`
Expected: PASS (all rule unit tests + integration).

- [ ] **Step 8: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/src/metrics.ts \
        agent/extensions/pi-toolcall-guard/index.ts \
        agent/extensions/pi-toolcall-guard/test/integration.test.ts
git commit -m "feat(guard): wire rule engine into tool_call/tool_result with rule metric"
```

---

### Task 7: Surface rule activity in the metrics report

`report.mjs` aggregates the JSONL metrics. Add two counters — `ruleBlocks` and `ruleReminds` — mirroring the existing `nudges` handling, and show them as a `rule b/r` column.

**Files:**
- Modify: `agent/extensions/pi-toolcall-guard/scripts/report.mjs`
- Test: `agent/extensions/pi-toolcall-guard/test/report.test.ts` (create if absent)

**Interfaces:**
- Consumes: the `{ kind: "rule"; toolName; action; rules }` events written in Task 6.

- [ ] **Step 1: Write the failing report test**

Create (or append to) `test/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aggregate, parseEvents } from "../scripts/report.mjs";

describe("report aggregation — rule events", () => {
	it("counts rule blocks and reminders per tool", () => {
		const text = [
			JSON.stringify({ kind: "rule", toolName: "bash", action: "block", rules: "no-git-add-all" }),
			JSON.stringify({ kind: "rule", toolName: "edit", action: "remind", rules: "no-todo" }),
			JSON.stringify({ kind: "rule", toolName: "edit", action: "remind", rules: "no-any" }),
		].join("\n");
		const { rows, totals } = aggregate(parseEvents(text));
		const bash = rows.find((r) => r.tool === "bash");
		const edit = rows.find((r) => r.tool === "edit");
		expect(bash.ruleBlocks).toBe(1);
		expect(edit.ruleReminds).toBe(2);
		expect(totals.ruleBlocks).toBe(1);
		expect(totals.ruleReminds).toBe(2);
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/report.test.ts`
Expected: FAIL — `ruleBlocks`/`ruleReminds` are `undefined`.

- [ ] **Step 3: Add the counters to `report.mjs`**

In `scripts/report.mjs`, make four edits:

(a) row initializer (line 20) — add the two fields:
```js
			r = { tool, blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0, nudges: 0, ruleBlocks: 0, ruleReminds: 0 };
```

(b) event loop (after the `nudge` branch, line 31) — add:
```js
			else if (e.kind === "rule") { if (e.action === "block") r.ruleBlocks++; else r.ruleReminds++; }
```

(c) totals reducer (lines 42-54) — add both fields to the accumulator object and to the initial object:
```js
				nudges: t.nudges + r.nudges,
				ruleBlocks: t.ruleBlocks + r.ruleBlocks,
				ruleReminds: t.ruleReminds + r.ruleReminds,
```
and in the initial value:
```js
			{ tool: "TOTAL", blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0, nudges: 0, ruleBlocks: 0, ruleReminds: 0 },
```

(d) `formatReport` (lines 60-61) — add a `rule b/r` column to the header and row:
```js
	const header = ["tool", "blocks", "norm", "recov", "recov%", "enrich", "nudge", "rule b/r"].join("\t");
	const fmt = (r) => [r.tool, r.blocks, r.normalized, r.recovered, `${(r.recoveryRate * 100).toFixed(0)}%`, `${r.enrichMatched}/${r.enrichTotal}`, r.nudges, `${r.ruleBlocks}/${r.ruleReminds}`].join("\t");
```

- [ ] **Step 4: Run the report test, then the full suite**

Run: `npx vitest run test/report.test.ts`
Expected: PASS.
Run: `npx vitest run`
Expected: PASS (entire guard suite).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-toolcall-guard/scripts/report.mjs \
        agent/extensions/pi-toolcall-guard/test/report.test.ts
git commit -m "feat(guard): report rule block/remind counts per tool"
```

---

## Out of scope (deliberate, do not implement)

- **Prose/thinking rules** (`message_update` + `ctx.abort()` + re-inject). The matcher retains dormant `text`/`thinking` scope support, but no prose event is subscribed. Add later only if needed.
- **Cross-session suppression** (`pi.appendEntry` / repeat policy). A violation re-fires every time by design.
- **Migrating the hardcoded `nudge.ts` into bundled rules.** The nudge stays as-is; bundled rules deliberately do not duplicate it (no `cat`/`grep`/`sed` rules), so there is no double-fire. Fold it in as a follow-up once the rule engine is proven.
- **ast-grep / structural conditions.** Regex only.

## Self-Review notes

- **Spec coverage:** every ported pi-ttsr pure module (glob, frontmatter, types, monitor, render, extract, loader) maps to Tasks 1-4; the engine and guard wiring (the new work) are Tasks 5-6; observability is Task 7. The one mandatory correctness fix (hashline `lines`) is Task 3.
- **Type consistency:** `RuleDecision.action` is `"block" | "remind"` everywhere (engine, index stash, metrics `rule` event); the metrics field is `rules: string` (comma-joined names); report counters are `ruleBlocks`/`ruleReminds`. `loadRules` signature is identical to the spec's with `projectRulesDir` defaulting to `.pi/guard-rules`.
- **Default-action wiring:** `DEFAULT_SETTINGS.interruptMode = "never"` (Task 1) is what makes unmarked rules soft; bundled blockers set `interruptMode: always` (Task 4). Verified by the render smoke test (Task 2) and the engine tests (Task 5).

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

import { describe, expect, it } from "vitest";
import { RuleMonitor } from "../../src/rules/monitor";
import { DEFAULT_SETTINGS, type MatchContext, type Rule, type TtsrSettings } from "../../src/rules/types";

function makeMonitor(overrides?: Partial<TtsrSettings>): RuleMonitor {
	return new RuleMonitor({ ...DEFAULT_SETTINGS, ...overrides });
}

const noAny: Rule = {
	name: "ts-no-any",
	content: "no any",
	condition: [": any|as any"],
	scope: ["tool:edit(*.ts)", "tool:write(*.ts)"],
};

describe("RuleMonitor.addRule", () => {
	it("registers a valid rule", () => {
		const m = makeMonitor();
		expect(m.addRule(noAny)).toBe(true);
		expect(m.hasRules()).toBe(true);
	});

	it("rejects duplicate names", () => {
		const m = makeMonitor();
		expect(m.addRule(noAny)).toBe(true);
		expect(m.addRule(noAny)).toBe(false);
	});

	it("rejects rules with no compilable condition", () => {
		const m = makeMonitor();
		expect(m.addRule({ name: "empty", content: "x", condition: [] })).toBe(false);
		expect(m.addRule({ name: "bad", content: "x", condition: ["("] })).toBe(false);
	});

	it("does not register when disabled globally", () => {
		const m = makeMonitor({ enabled: false });
		expect(m.addRule(noAny)).toBe(false);
	});
});

describe("RuleMonitor.check — scope", () => {
	it("matches on the scoped tool + path", () => {
		const m = makeMonitor();
		m.addRule(noAny);
		const hits = m.check("const x: any = 1;", { source: "tool", toolName: "edit", filePaths: ["a.ts"] });
		expect(hits.map((r) => r.name)).toEqual(["ts-no-any"]);
	});

	it("does not match a path outside the glob", () => {
		const m = makeMonitor();
		m.addRule(noAny);
		const hits = m.check("const x: any = 1;", { source: "tool", toolName: "edit", filePaths: ["a.rs"] });
		expect(hits).toEqual([]);
	});

	it("does not match the wrong tool", () => {
		const m = makeMonitor();
		m.addRule(noAny);
		const hits = m.check("const x: any = 1;", { source: "tool", toolName: "bash", filePaths: ["a.ts"] });
		expect(hits).toEqual([]);
	});

	it("default scope allows text and any tool but not thinking", () => {
		const m = makeMonitor();
		m.addRule({ name: "todo", content: "x", condition: ["TODO"] });
		expect(m.check("TODO fix", { source: "text" }).length).toBe(1);
		expect(m.check("TODO fix", { source: "tool", toolName: "edit", filePaths: ["a.ts"] }).length).toBe(1);
		expect(m.check("TODO fix", { source: "thinking" }).length).toBe(0);
	});
});

describe("RuleMonitor.check — global globs", () => {
	it("gates a match on the global glob", () => {
		const m = makeMonitor();
		m.addRule({ name: "g", content: "x", condition: ["secret"], scope: ["tool"], globs: ["*.env"] });
		expect(m.check("secret", { source: "tool", toolName: "write", filePaths: ["a.env"] }).length).toBe(1);
		expect(m.check("secret", { source: "tool", toolName: "write", filePaths: ["a.ts"] }).length).toBe(0);
	});
});

describe("RuleMonitor — repeat policy", () => {
	it("once: a rule fires only once after injection", () => {
		const m = makeMonitor({ repeatMode: "once" });
		m.addRule(noAny);
		const ctx: MatchContext = { source: "tool", toolName: "edit", filePaths: ["a.ts"] };
		const first = m.check("x: any", ctx);
		expect(first.length).toBe(1);
		m.markInjected(first);
		expect(m.check("x: any", ctx).length).toBe(0);
	});

	it("after-gap: re-fires only once enough turns pass", () => {
		const m = makeMonitor({ repeatMode: "after-gap", repeatGap: 2 });
		m.addRule(noAny);
		const ctx: MatchContext = { source: "tool", toolName: "edit", filePaths: ["a.ts"] };
		m.markInjected(m.check("x: any", ctx));
		expect(m.check("x: any", ctx).length).toBe(0); // gap 0
		m.incrementMessageCount();
		expect(m.check("x: any", ctx).length).toBe(0); // gap 1
		m.incrementMessageCount();
		expect(m.check("x: any", ctx).length).toBe(1); // gap 2
	});

	it("restoreInjected suppresses a rule after reload", () => {
		const m = makeMonitor({ repeatMode: "once" });
		m.addRule(noAny);
		m.restoreInjected(["ts-no-any"]);
		expect(m.check("x: any", { source: "tool", toolName: "edit", filePaths: ["a.ts"] }).length).toBe(0);
	});
});

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

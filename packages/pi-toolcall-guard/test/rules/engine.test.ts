import { describe, expect, it } from "vitest";
import { RuleEngine } from "../../src/rules/engine";
import { DEFAULT_SETTINGS, type Rule } from "../../src/rules/types";
import { renderStreamReminder } from "../../src/rules/render";

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

describe("renderStreamReminder", () => {
	it("renders a compact one-line system-reminder with the rule name and body", () => {
		const out = renderStreamReminder({ name: "no-refuse", content: "Attempt the task.", condition: ["x"] });
		expect(out).toBe("<system-reminder>[rule:no-refuse] Attempt the task.</system-reminder>");
		expect(out).not.toContain("\n");
	});
});

describe("RuleEngine.checkProse", () => {
	const refuse: Rule = { name: "no-refuse", content: "Attempt the task.", condition: ["I cannot help"], scope: ["text"], interruptMode: "always" };
	const softProse: Rule = { name: "note", content: "noted", condition: ["whatever"], scope: ["text"] }; // default => never => not interrupting

	it("returns an interrupt decision for a matching always-rule in text", () => {
		const engine = new RuleEngine([refuse], DEFAULT_SETTINGS);
		const d = engine.checkProse("...sorry, I cannot help with that", "text");
		expect(d?.ruleNames).toEqual(["no-refuse"]);
		expect(d?.text).toContain("<system-reminder>[rule:no-refuse]");
	});

	it("ignores a non-interrupting (soft) prose match", () => {
		const engine = new RuleEngine([softProse], DEFAULT_SETTINGS);
		expect(engine.checkProse("whatever you say", "text")).toBeUndefined();
	});

	it("returns undefined for no match, empty text, or no rules", () => {
		const engine = new RuleEngine([refuse], DEFAULT_SETTINGS);
		expect(engine.checkProse("all good here", "text")).toBeUndefined();
		expect(engine.checkProse("", "text")).toBeUndefined();
		expect(new RuleEngine([], DEFAULT_SETTINGS).checkProse("I cannot help", "text")).toBeUndefined();
	});

	it("does not match a text rule against the thinking source it isn't scoped to", () => {
		const engine = new RuleEngine([refuse], DEFAULT_SETTINGS); // scope:["text"] only
		expect(engine.checkProse("I cannot help", "thinking")).toBeUndefined();
	});
});

import { describe, expect, it, vi } from "vitest";
import { StreamWatcher, type ProseCheck } from "../../src/stream/watcher";

function msg(text: string) {
	return { content: [{ type: "text", text }] };
}
function actions() {
	return { abort: vi.fn(), inject: vi.fn(), notify: vi.fn(), record: vi.fn() };
}
// check that fires for any text containing "banana"
const bananaCheck: ProseCheck = (text) =>
	text.includes("banana") ? { text: "<system-reminder>[rule:b] no banana</system-reminder>", ruleNames: ["b"] } : undefined;

describe("StreamWatcher", () => {
	it("aborts and injects on the first matching delta", () => {
		const w = new StreamWatcher();
		const a = actions();
		const fired = w.onMessageUpdate(msg("here is a banana now"), bananaCheck, a);
		expect(fired).toEqual(["b"]);
		expect(a.abort).toHaveBeenCalledTimes(1);
		expect(a.inject).toHaveBeenCalledWith("<system-reminder>[rule:b] no banana</system-reminder>");
		expect(a.record).toHaveBeenCalledWith("b", "text");
	});

	it("does nothing for a non-matching delta", () => {
		const w = new StreamWatcher();
		const a = actions();
		expect(w.onMessageUpdate(msg("apples and oranges"), bananaCheck, a)).toBeNull();
		expect(a.abort).not.toHaveBeenCalled();
	});

	it("aborts at most once per message (no second abort on a later delta)", () => {
		const w = new StreamWatcher();
		const a = actions();
		w.onMessageUpdate(msg("banana one"), bananaCheck, a);
		w.onMessageUpdate(msg("banana one banana two"), bananaCheck, a);
		expect(a.abort).toHaveBeenCalledTimes(1);
	});

	it("re-arms after onTurnStart but stays suppressed once per session", () => {
		const w = new StreamWatcher();
		const a = actions();
		w.onMessageUpdate(msg("banana"), bananaCheck, a); // fires, marks "b" fired
		w.onTurnStart(); // new turn: per-message guard resets
		const second = w.onMessageUpdate(msg("banana again"), bananaCheck, a);
		expect(second).toBeNull(); // "b" already fired this session
		expect(a.abort).toHaveBeenCalledTimes(1);
	});

	it("only scans the tail window, so an early match that scrolled out is missed", () => {
		const w = new StreamWatcher(10); // tiny window
		const a = actions();
		// "banana" is at the start; tail of 10 chars is "...four five" — no banana
		const long = "banana " + "x".repeat(40);
		expect(w.onMessageUpdate(msg(long), bananaCheck, a)).toBeNull();
		expect(a.abort).not.toHaveBeenCalled();
	});

	it("scans thinking blocks too", () => {
		const w = new StreamWatcher();
		const a = actions();
		const fired = w.onMessageUpdate({ content: [{ type: "thinking", thinking: "I should mention banana" }] }, bananaCheck, a);
		expect(fired).toEqual(["b"]);
		expect(a.record).toHaveBeenCalledWith("b", "thinking");
	});
});

import { describe, it, expect } from "vitest";
import {
	countVisibleLines,
	decideReread,
	type RereadEntry,
} from "../../src/reread";

describe("countVisibleLines", () => {
	it("counts zero for empty content", () => {
		expect(countVisibleLines("")).toBe(0);
	});
	it("counts a single unterminated line", () => {
		expect(countVisibleLines("alpha")).toBe(1);
	});
	it("ignores a single trailing newline sentinel", () => {
		expect(countVisibleLines("alpha\n")).toBe(1);
	});
	it("counts two lines without trailing newline", () => {
		expect(countVisibleLines("alpha\nbeta")).toBe(2);
	});
	it("counts two lines with trailing newline", () => {
		expect(countVisibleLines("alpha\nbeta\n")).toBe(2);
	});
});

describe("decideReread", () => {
	const entry = (content: string, lastWasStub: boolean): RereadEntry => ({
		content,
		lastWasStub,
	});

	it("returns 'first' when there is no prior entry", () => {
		expect(decideReread(undefined, "x")).toBe("first");
	});
	it("returns 'stub' on identical content after a real render", () => {
		expect(decideReread(entry("x", false), "x")).toBe("stub");
	});
	it("returns 'force-full' on identical content after a stub", () => {
		expect(decideReread(entry("x", true), "x")).toBe("force-full");
	});
	it("returns 'changed' when content differs", () => {
		expect(decideReread(entry("x", false), "y")).toBe("changed");
	});
	it("returns 'changed' when content differs even after a stub", () => {
		expect(decideReread(entry("x", true), "y")).toBe("changed");
	});
});

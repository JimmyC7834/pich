import { describe, it, expect } from "vitest";
import { applyReread, type RereadState } from "../../src/reread";

describe("applyReread", () => {
	it("records the first read and returns null (caller shows full)", () => {
		const state: RereadState = new Map();
		const out = applyReread(state, "/f", "alpha\n", "PREVIEW");
		expect(out).toBeNull();
		expect(state.get("/f")).toEqual({ content: "alpha\n", lastWasStub: false });
	});

	it("emits an unchanged notice on the first identical re-read", () => {
		const state: RereadState = new Map();
		applyReread(state, "/f", "alpha\n", "PREVIEW");
		const out = applyReread(state, "/f", "alpha\n", "PREVIEW");
		expect(out?.mode).toBe("unchanged");
		expect(out?.text).toContain("Unchanged since last read");
		expect(state.get("/f")?.lastWasStub).toBe(true);
	});

	it("breaks the loop: a second identical re-read after a stub returns null", () => {
		const state: RereadState = new Map();
		applyReread(state, "/f", "alpha\n", "PREVIEW"); // first  -> null
		applyReread(state, "/f", "alpha\n", "PREVIEW"); // second -> stub
		const out = applyReread(state, "/f", "alpha\n", "PREVIEW"); // third
		expect(out).toBeNull();
		expect(state.get("/f")?.lastWasStub).toBe(false);
	});

	it("emits a changed notice and updates stored content on change", () => {
		const state: RereadState = new Map();
		applyReread(state, "/f", "alpha\nbeta\n", "PREVIEW");
		const out = applyReread(state, "/f", "alpha\nBETA\n", "PREVIEW");
		expect(out?.mode).toBe("changed-diff");
		expect(out?.text).toContain("Changed since last read");
		expect(state.get("/f")).toEqual({
			content: "alpha\nBETA\n",
			lastWasStub: false,
		});
	});

	it("isolates state by path", () => {
		const state: RereadState = new Map();
		applyReread(state, "/a", "x\n", "PREVIEW");
		const out = applyReread(state, "/b", "x\n", "PREVIEW");
		expect(out).toBeNull(); // /b is a first read, not a re-read of /a
	});
});

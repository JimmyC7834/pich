import { describe, it, expect } from "vitest";
import { renderChangedNotice, renderUnchangedNotice } from "../../src/reread";

const ANCHOR_RE = /\d+#[ZPMQVRWSNKTXJBYH]{2}:/;

describe("renderUnchangedNotice", () => {
	it("states the file is unchanged and reports the line count", () => {
		const text = renderUnchangedNotice("alpha\nbeta\n");
		expect(text).toContain("Unchanged since last read");
		expect(text).toContain("2 lines");
	});
	it("tells the model to reuse its prior anchors", () => {
		const text = renderUnchangedNotice("alpha\n");
		expect(text.toLowerCase()).toContain("reuse your anchors");
	});
});

describe("renderChangedNotice", () => {
	it("returns an anchored diff for a small change", () => {
		const prev = "alpha\nbeta\ngamma\n";
		const curr = "alpha\nBETA\ngamma\n";
		const { text, mode } = renderChangedNotice(prev, curr, "FULL_PREVIEW");
		expect(mode).toBe("changed-diff");
		expect(text).toContain("Changed since last read");
		expect(text).toContain("BETA");
		expect(text).toMatch(ANCHOR_RE);
		expect(text).not.toContain("FULL_PREVIEW");
	});

	it("falls back to the full preview when the diff exceeds the budget", () => {
		const prev = "a\nb\nc\nd\n";
		const curr = "A\nB\nC\nD\n";
		const { text, mode } = renderChangedNotice(prev, curr, "FULL_PREVIEW", 1);
		expect(mode).toBe("changed-full");
		expect(text).toContain("showing full file");
		expect(text).toContain("FULL_PREVIEW");
	});
});

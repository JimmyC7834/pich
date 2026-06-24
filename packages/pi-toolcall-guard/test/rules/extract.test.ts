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

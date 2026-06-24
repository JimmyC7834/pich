import { describe, expect, it } from "vitest";
import { parseRuleFile } from "../../src/rules/frontmatter";

describe("parseRuleFile", () => {
	it("parses scalar frontmatter and body", () => {
		const { frontmatter, body } = parseRuleFile(
			['---', 'description: Hello world', 'condition: "Box::leak"', '---', '', 'Body text here.'].join("\n"),
		);
		expect(frontmatter.description).toBe("Hello world");
		expect(frontmatter.condition).toBe("Box::leak");
		expect(body).toBe("Body text here.");
	});

	it("preserves regex backslashes inside double quotes", () => {
		const { frontmatter } = parseRuleFile(
			['---', 'condition: "\\\\.lock\\\\(\\\\)\\\\.unwrap\\\\(\\\\)"', '---', 'x'].join("\n"),
		);
		expect(frontmatter.condition).toBe("\\.lock\\(\\)\\.unwrap\\(\\)");
	});

	it("parses block lists", () => {
		const { frontmatter } = parseRuleFile(
			['---', 'condition:', '  - "once_cell::"', '  - "OnceLock::new"', '---', 'body'].join("\n"),
		);
		expect(frontmatter.condition).toEqual(["once_cell::", "OnceLock::new"]);
	});

	it("handles files with no frontmatter", () => {
		const { frontmatter, body } = parseRuleFile("Just a body");
		expect(frontmatter).toEqual({});
		expect(body).toBe("Just a body");
	});

	it("compiles a preserved regex correctly", () => {
		const { frontmatter } = parseRuleFile(['---', 'condition: "new Promise\\\\("', '---', 'b'].join("\n"));
		const regex = new RegExp(frontmatter.condition as string);
		expect(regex.test("const p = new Promise(")).toBe(true);
		expect(regex.test("Promise.withResolvers()")).toBe(false);
	});
});

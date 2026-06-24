import { describe, expect, it } from "vitest";
import { enrichError, RULES } from "../src/enrich";

describe("enrichError", () => {
	it("returns null when no rule matches", () => {
		expect(enrichError("bash", "some unremarkable output")).toBeNull();
	});

	it("enriches ENOENT errors with an ls/find pointer", () => {
		const out = enrichError("read", "ENOENT: no such file or directory, open 'x'");
		expect(out).not.toBeNull();
		expect(out!.rule).toBe("enoent");
		expect(out!.text).toContain("ENOENT");
		expect(out!.text).toContain("[guard]");
	});

	it("enriches schema-validation errors with a parameter-name pointer", () => {
		const out = enrichError("read", "Invalid arguments: unknown property 'filepath'");
		expect(out!.rule).toBe("schema");
	});

	it("enriches stale-anchor errors before falling through to not-found", () => {
		const out = enrichError("edit", "Edit failed: stale anchor, hash mismatch on line 12");
		expect(out!.rule).toBe("stale-anchor");
		expect(out!.text.toLowerCase()).toContain("re-read");
	});

	it("enriches command-not-found", () => {
		const out = enrichError("bash", "bash: foo: command not found");
		expect(out!.rule).toBe("command-not-found");
	});

	it("enriches permission errors", () => {
		const out = enrichError("write", "EACCES: permission denied, open 'x'");
		expect(out!.rule).toBe("permission");
	});

	it("appends exactly one hint block", () => {
		const out = enrichError("read", "ENOENT: no such file");
		expect(out!.text.match(/\[guard\]/g)).toHaveLength(1);
	});

	it("RULES are uniquely identified", () => {
		const ids = RULES.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

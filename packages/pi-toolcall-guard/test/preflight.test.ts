import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../src/preflight";

describe("preflight", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "guard-preflight-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "utils.ts"), "");
	});
	afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

	it("passes an existing read path unchanged", () => {
		expect(preflight({ toolName: "read", input: { path: "src/utils.ts" }, cwd: dir }))
			.toEqual({ kind: "pass" });
	});

	it("passes unknown tools", () => {
		expect(preflight({ toolName: "expand", input: { path: "whatever" }, cwd: dir }))
			.toEqual({ kind: "pass" });
	});

	it("passes optional-path tools that omit the path", () => {
		expect(preflight({ toolName: "grep", input: { pattern: "x" }, cwd: dir }))
			.toEqual({ kind: "pass" });
	});

	it("normalizes a quoted path that exists, returning the repaired value", () => {
		const out = preflight({ toolName: "read", input: { path: '"src/utils.ts"' }, cwd: dir });
		expect(out).toEqual({ kind: "normalized", key: "path", value: "src/utils.ts" });
	});

	it("blocks a nonexistent read path and suggests the near match", () => {
		const out = preflight({ toolName: "read", input: { path: "src/util.ts" }, cwd: dir });
		expect(out.kind).toBe("block");
		if (out.kind === "block") {
			expect(out.reason).toContain("does not exist");
			expect(out.reason).toContain("src/utils.ts");
		}
	});

	it("blocks a nonexistent read path with an ls/find pointer when no near match", () => {
		const out = preflight({ toolName: "read", input: { path: "src/zzzzzzzz.ts" }, cwd: dir });
		expect(out.kind).toBe("block");
		if (out.kind === "block") expect(out.reason).toMatch(/ls|find/);
	});

	it("passes a write to a new file when the parent dir exists", () => {
		expect(preflight({ toolName: "write", input: { path: "src/new.ts", content: "x" }, cwd: dir }))
			.toEqual({ kind: "pass" });
	});

	it("auto-creates parent dir for write to nonexistent path", () => {
		const out = preflight({ toolName: "write", input: { path: "nope/new.ts", content: "x" }, cwd: dir });
		expect(out.kind).toBe("pass");
		// verify the dir was created
		expect(existsSync(join(dir, "nope"))).toBe(true);
	});
});

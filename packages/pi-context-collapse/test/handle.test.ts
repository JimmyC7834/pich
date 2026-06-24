import { describe, expect, it } from "vitest";
import { hashContent, makeHandle, parseHandle } from "../src/handle";

describe("handle", () => {
	it("hashContent is deterministic, 12 lowercase hex chars", () => {
		const h = hashContent("hello");
		expect(h).toMatch(/^[0-9a-f]{12}$/);
		expect(hashContent("hello")).toBe(h);
		expect(hashContent("world")).not.toBe(h);
	});
	it("makeHandle wraps type:hash in U+27E6/27E7", () => {
		expect(makeHandle("json", "abc123abc123")).toBe("⟦json:abc123abc123⟧");
	});
	it("parseHandle round-trips a handle embedded in surrounding text", () => {
		const handle = makeHandle("log", "deadbeef0000");
		expect(parseHandle(`prefix ${handle} suffix`)).toEqual({ type: "log", hash: "deadbeef0000" });
	});
	it("parseHandle returns null when no handle present", () => {
		expect(parseHandle("just text")).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { classify } from "../src/router";

const big = (line: string, n: number) => Array.from({ length: n }, () => line).join("\n");

describe("classify", () => {
	it("exempts read and edit regardless of content", () => {
		const json = JSON.stringify({ a: 1, b: "x".repeat(2000) });
		expect(classify("read", json)).toBeNull();
		expect(classify("edit", json)).toBeNull();
	});
	it("exempts expand so its recovered raw is never re-collapsed", () => {
		// The expand tool returns the raw original on the recovery path. If its
		// result were collapsed, expand would re-collapse what it just expanded
		// and the agent would never see the raw it asked for (reversibility break).
		const json = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ name: `r${i}`, stars: i })));
		expect(classify("expand", json)).toBeNull();
	});
	it("passes through small content", () => {
		expect(classify("bash", "small output")).toBeNull();
	});
	it("classifies large JSON as json", () => {
		const json = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ i })) });
		expect(classify("bash", json)).toBe("json");
	});
	it("classifies repetitive log output as log", () => {
		// line is long enough that 30 copies clear the 200-token floor
		const text = big("INFO 2026-06-17T00:00:00 worker tick processing queued item", 30);
		expect(classify("bash", text)).toBe("log");
	});
	it("classifies a large bare-path list as paths", () => {
		const text = Array.from({ length: 50 }, (_, i) => `src/dir/file${i}.ts`).join("\n");
		expect(classify("bash", text)).toBe("paths");
	});
	it("does NOT classify code (non-json, low-dup, not path list)", () => {
		const code = Array.from({ length: 60 }, (_, i) => `  const v${i} = compute(${i}) + offset;`).join("\n");
		expect(classify("bash", code)).toBeNull();
	});
});

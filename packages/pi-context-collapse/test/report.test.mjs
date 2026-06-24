import { describe, expect, it } from "vitest";
import { parseEvents, aggregate } from "../scripts/report.mjs";

describe("report aggregate", () => {
	it("parses JSONL and skips blank/malformed lines", () => {
		const text = [
			'{"kind":"collapse","type":"json","rawTokens":100,"collapsedTokens":10}',
			"",
			"not json",
			'{"kind":"expand","type":"json","returnedTokens":30}',
		].join("\n");
		expect(parseEvents(text)).toHaveLength(2);
	});

	it("computes gross saved, returned, net, and expand-rate per type", () => {
		const events = [
			{ kind: "collapse", type: "json", rawTokens: 100, collapsedTokens: 10 },
			{ kind: "collapse", type: "json", rawTokens: 200, collapsedTokens: 20 },
			{ kind: "expand", type: "json", returnedTokens: 50 },
			{ kind: "collapse", type: "log", rawTokens: 80, collapsedTokens: 30 },
		];
		const { rows, totals } = aggregate(events);

		const json = rows.find((r) => r.type === "json");
		expect(json.collapses).toBe(2);
		expect(json.expands).toBe(1);
		expect(json.grossSaved).toBe(270); // (100-10)+(200-20)
		expect(json.returnedTokens).toBe(50);
		expect(json.netSaved).toBe(220); // 270 - 50
		expect(json.expandRate).toBeCloseTo(0.5); // 1 expand / 2 collapses

		const log = rows.find((r) => r.type === "log");
		expect(log.grossSaved).toBe(50);
		expect(log.expandRate).toBe(0); // no expands

		expect(totals.grossSaved).toBe(320); // 270 + 50
		expect(totals.netSaved).toBe(270); // 320 - 50
		expect(totals.collapses).toBe(3);
		expect(totals.expands).toBe(1);
	});

	it("rows are sorted by gross saved descending", () => {
		const { rows } = aggregate([
			{ kind: "collapse", type: "log", rawTokens: 50, collapsedTokens: 10 },
			{ kind: "collapse", type: "json", rawTokens: 500, collapsedTokens: 10 },
		]);
		expect(rows[0].type).toBe("json");
	});
});

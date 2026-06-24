import { describe, expect, it } from "vitest";
import { parseEvents, aggregate, formatReport } from "../scripts/report.mjs";

describe("report aggregate", () => {
	it("parses JSONL and skips blank/malformed lines", () => {
		const text = [
			'{"kind":"preflight","outcome":"block","toolName":"read"}',
			"",
			"not json",
			'{"kind":"preflight_recovered","toolName":"read"}',
		].join("\n");
		expect(parseEvents(text)).toHaveLength(2);
	});

	it("computes blocks, recoveries, recovery rate, and enrich counts per tool", () => {
		const events = [
			{ kind: "preflight", outcome: "block", toolName: "read" },
			{ kind: "preflight", outcome: "block", toolName: "read" },
			{ kind: "preflight", outcome: "normalized", toolName: "read" },
			{ kind: "preflight_recovered", toolName: "read" },
			{ kind: "enrich", matched: true, rule: "enoent", toolName: "bash" },
			{ kind: "enrich", matched: false, toolName: "bash" },
		];
		const { rows, totals } = aggregate(events);
		const read = rows.find((r) => r.tool === "read");
		expect(read.blocks).toBe(2);
		expect(read.normalized).toBe(1);
		expect(read.recovered).toBe(1);
		expect(read.recoveryRate).toBeCloseTo(0.5);
		const bash = rows.find((r) => r.tool === "bash");
		expect(bash.enrichMatched).toBe(1);
		expect(bash.enrichTotal).toBe(2);
		expect(totals.blocks).toBe(2);
		expect(totals.recovered).toBe(1);
		expect(totals.recoveryRate).toBeCloseTo(0.5);
	});

	it("breaks sort ties deterministically by tool name", () => {
		const { rows } = aggregate([
			{ kind: "preflight", outcome: "block", toolName: "zeta" },
			{ kind: "preflight", outcome: "block", toolName: "alpha" },
		]);
		// Both score blocks+enrichTotal = 1; tie broken alphabetically.
		expect(rows.map((r) => r.tool)).toEqual(["alpha", "zeta"]);
	});

	it("formatReport renders a header and a TOTAL row", () => {
		const out = formatReport(aggregate([{ kind: "preflight", outcome: "block", toolName: "read" }]));
		expect(out).toContain("tool\tblocks");
		expect(out).toContain("TOTAL");
	});

	it("counts nudge events per tool and shows a nudge column", () => {
		const { rows, totals } = aggregate([
			{ kind: "nudge", toolName: "bash", rule: "cat-read", tool: "read" },
			{ kind: "nudge", toolName: "bash", rule: "grep", tool: "grep" },
		]);
		const bash = rows.find((r) => r.tool === "bash");
		expect(bash.nudges).toBe(2);
		expect(totals.nudges).toBe(2);
		expect(formatReport({ rows, totals })).toContain("nudge");
	});
});

describe("report aggregation — rule events", () => {
	it("counts rule blocks and reminders per tool", () => {
		const text = [
			JSON.stringify({ kind: "rule", toolName: "bash", action: "block", rules: "no-git-add-all" }),
			JSON.stringify({ kind: "rule", toolName: "edit", action: "remind", rules: "no-todo" }),
			JSON.stringify({ kind: "rule", toolName: "edit", action: "remind", rules: "no-any" }),
		].join("\n");
		const { rows, totals } = aggregate(parseEvents(text));
		const bash = rows.find((r) => r.tool === "bash");
		const edit = rows.find((r) => r.tool === "edit");
		expect(bash.ruleBlocks).toBe(1);
		expect(edit.ruleReminds).toBe(2);
		expect(totals.ruleBlocks).toBe(1);
		expect(totals.ruleReminds).toBe(2);
	});
});

describe("report aggregation — stream events", () => {
	it("counts stream interrupts per tool bucket and in totals", () => {
		const text = [
			JSON.stringify({ kind: "stream", toolName: "(stream)", source: "text", rule: "no-refuse" }),
			JSON.stringify({ kind: "stream", toolName: "(stream)", source: "thinking", rule: "no-guess" }),
		].join("\n");
		const { rows, totals } = aggregate(parseEvents(text));
		const s = rows.find((r) => r.tool === "(stream)");
		expect(s.streamInterrupts).toBe(2);
		expect(totals.streamInterrupts).toBe(2);
	});
});

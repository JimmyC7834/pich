// Effectiveness report for pi-context-collapse.
//
// Reads a .pi-collapse-metrics.jsonl file and prints, per content type:
//   - collapses / expands counts and the expand-rate (the keep/drop signal)
//   - gross tokens saved by collapsing (rawTokens - collapsedTokens)
//   - tokens returned by expand calls (the cost that offsets savings)
//   - NET tokens saved (gross - returned)
//
// Usage:
//   node scripts/report.mjs <path-to-metrics.jsonl>
//   npm run report -- <path-to-metrics.jsonl>
// If no path is given, tries $PI_COLLAPSE_DIR/.pi-collapse-metrics.jsonl,
// then ./.pi-collapse-metrics.jsonl.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Parse JSONL text into metric event objects, skipping blank/malformed lines. */
export function parseEvents(text) {
	const events = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed));
		} catch {
			// skip malformed lines — best-effort, the log is append-only
		}
	}
	return events;
}

/** Aggregate events into per-type effectiveness rows plus overall totals. */
export function aggregate(events) {
	const byType = new Map();
	const row = (t) => {
		if (!byType.has(t)) {
			byType.set(t, {
				type: t,
				collapses: 0,
				expands: 0,
				rawTokens: 0,
				collapsedTokens: 0,
				returnedTokens: 0,
			});
		}
		return byType.get(t);
	};

	for (const e of events) {
		const r = row(e.type ?? "unknown");
		if (e.kind === "collapse") {
			r.collapses += 1;
			r.rawTokens += e.rawTokens ?? 0;
			r.collapsedTokens += e.collapsedTokens ?? 0;
		} else if (e.kind === "expand") {
			r.expands += 1;
			r.returnedTokens += e.returnedTokens ?? 0;
		}
	}

	const rows = [...byType.values()]
		.map((r) => {
			const grossSaved = r.rawTokens - r.collapsedTokens;
			return {
				...r,
				grossSaved,
				netSaved: grossSaved - r.returnedTokens,
				expandRate: r.collapses ? r.expands / r.collapses : 0,
			};
		})
		.sort((a, b) => b.grossSaved - a.grossSaved);

	const totals = rows.reduce(
		(acc, r) => ({
			collapses: acc.collapses + r.collapses,
			expands: acc.expands + r.expands,
			grossSaved: acc.grossSaved + r.grossSaved,
			returnedTokens: acc.returnedTokens + r.returnedTokens,
			netSaved: acc.netSaved + r.netSaved,
		}),
		{ collapses: 0, expands: 0, grossSaved: 0, returnedTokens: 0, netSaved: 0 },
	);
	totals.expandRate = totals.collapses ? totals.expands / totals.collapses : 0;

	return { rows, totals };
}

function pct(n) {
	return `${(n * 100).toFixed(0)}%`;
}

/** Render an aggregate report as a fixed-width text table. */
export function formatReport({ rows, totals }) {
	if (rows.length === 0) return "No metric events found.";
	const cols = ["type", "collapse", "expand", "exp-rate", "gross", "returned", "NET"];
	const widths = [8, 8, 6, 8, 9, 9, 9];
	const fmt = (vals) =>
		vals.map((v, i) => String(v).padStart(widths[i])).join("  ");
	const out = [fmt(cols), fmt(widths.map((w) => "-".repeat(w)))];
	for (const r of rows) {
		out.push(
			fmt([r.type, r.collapses, r.expands, pct(r.expandRate), r.grossSaved, r.returnedTokens, r.netSaved]),
		);
	}
	out.push(fmt(widths.map((w) => "-".repeat(w))));
	out.push(
		fmt(["TOTAL", totals.collapses, totals.expands, pct(totals.expandRate), totals.grossSaved, totals.returnedTokens, totals.netSaved]),
	);
	out.push("");
	out.push(
		`NET ${totals.netSaved} tokens saved across ${totals.collapses} collapses (${totals.expands} expands re-pulled ${totals.returnedTokens}). ` +
			`A type with a high exp-rate and low/negative NET is a candidate to stop collapsing.`,
	);
	return out.join("\n");
}

function resolveDefaultPath() {
	const dir = process.env.PI_COLLAPSE_DIR;
	return dir
		? join(dir, ".pi-collapse-metrics.jsonl")
		: ".pi-collapse-metrics.jsonl";
}

function main(argv) {
	const path = argv[2] ?? resolveDefaultPath();
	let text;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		console.error(`Cannot read metrics file: ${path}`);
		console.error("Usage: node scripts/report.mjs <path-to-metrics.jsonl>");
		process.exit(1);
	}
	console.log(`Report for ${path}\n`);
	console.log(formatReport(aggregate(parseEvents(text))));
}

// Run main only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv);
}

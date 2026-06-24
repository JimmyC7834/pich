import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function parseEvents(text) {
	const out = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
	}
	return out;
}

export function aggregate(events) {
	const byTool = new Map();
	const get = (tool) => {
		let r = byTool.get(tool);
		if (!r) {
			r = { tool, blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0, nudges: 0, ruleBlocks: 0, ruleReminds: 0, streamInterrupts: 0 };
			byTool.set(tool, r);
		}
		return r;
	};
	for (const e of events) {
		const r = get(e.toolName);
		if (e.kind === "preflight" && e.outcome === "block") r.blocks++;
		else if (e.kind === "preflight" && e.outcome === "normalized") r.normalized++;
		else if (e.kind === "preflight_recovered") r.recovered++;
		else if (e.kind === "enrich") { r.enrichTotal++; if (e.matched) r.enrichMatched++; }
		else if (e.kind === "nudge") r.nudges++;
		else if (e.kind === "rule") { if (e.action === "block") r.ruleBlocks++; else r.ruleReminds++; }
		else if (e.kind === "stream") r.streamInterrupts++;
	}
	const rows = [...byTool.values()].map((r) => ({
		...r,
		recoveryRate: r.blocks ? r.recovered / r.blocks : 0,
	}));
	rows.sort(
		(a, b) =>
			b.blocks + b.enrichTotal + b.nudges - (a.blocks + a.enrichTotal + a.nudges) ||
			a.tool.localeCompare(b.tool),
	);
	const totals = rows.reduce(
		(t, r) => ({
			tool: "TOTAL",
			blocks: t.blocks + r.blocks,
			normalized: t.normalized + r.normalized,
			recovered: t.recovered + r.recovered,
			recoveryRate: 0,
			enrichMatched: t.enrichMatched + r.enrichMatched,
			enrichTotal: t.enrichTotal + r.enrichTotal,
			nudges: t.nudges + r.nudges,
			ruleBlocks: t.ruleBlocks + r.ruleBlocks,
			ruleReminds: t.ruleReminds + r.ruleReminds,
			streamInterrupts: t.streamInterrupts + r.streamInterrupts,
		}),
		{ tool: "TOTAL", blocks: 0, normalized: 0, recovered: 0, recoveryRate: 0, enrichMatched: 0, enrichTotal: 0, nudges: 0, ruleBlocks: 0, ruleReminds: 0, streamInterrupts: 0 },
	);
	totals.recoveryRate = totals.blocks ? totals.recovered / totals.blocks : 0;
	return { rows, totals };
}

export function formatReport({ rows, totals }) {
	const header = ["tool", "blocks", "norm", "recov", "recov%", "enrich", "nudge", "rule b/r", "stream"].join("\t");
	const fmt = (r) => [r.tool, r.blocks, r.normalized, r.recovered, `${(r.recoveryRate * 100).toFixed(0)}%`, `${r.enrichMatched}/${r.enrichTotal}`, r.nudges, `${r.ruleBlocks}/${r.ruleReminds}`, r.streamInterrupts].join("\t");
	return [header, ...rows.map(fmt), "—", fmt(totals)].join("\n");
}

// fileURLToPath normalizes the file:// URL to a native path (handles Windows
// drive letters and backslashes), so this correctly identifies direct CLI
// execution without firing when the module is imported by tests.
const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
	const dir = process.env.PI_GUARD_DIR ?? join(process.cwd(), ".pi", "guard");
	const path = join(dir, ".pi-guard-metrics.jsonl");
	let text = "";
	try { text = readFileSync(path, "utf8"); } catch { console.log(`No metrics at ${path}`); process.exit(0); }
	console.log(formatReport(aggregate(parseEvents(text))));
}

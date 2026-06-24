import type { UsageRow } from "./row.js";
import { summarize, ctxPercentSeries, type UsageSummary } from "./summary.js";

const BARS = "▁▂▃▄▅▆▇█";

/** Unicode sparkline scaled 0..100 (ctxPercent domain). */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  return values
    .map((v) => BARS[Math.max(0, Math.min(BARS.length - 1, Math.round((v / 100) * (BARS.length - 1))))])
    .join("");
}

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** Compact multi-line summary for the /usage command. */
export function renderSummary(rows: UsageRow[], allSessions: boolean): string {
  if (rows.length === 0) return "usage: no rows recorded yet.";
  const s: UsageSummary = summarize(rows);
  const t = s.totals;
  const scope = allSessions ? `${s.sessions} session(s)` : "this session";
  const pct = (s.cacheHitRatio * 100).toFixed(0);
  const ctxLine =
    s.ctx.last != null && s.ctx.window != null
      ? `ctx ${k(s.ctx.last)}/${k(s.ctx.window)} (max ${k(s.ctx.max ?? 0)})  ${sparkline(ctxPercentSeries(rows))}`
      : "ctx n/a";
  const cost = t.cost > 0 ? `  cost $${t.cost.toFixed(4)}` : "";
  return [
    `usage · ${scope} · ${s.turns} turn(s)`,
    `tokens  in ${k(t.input)}  out ${k(t.output)}  cacheR ${k(t.cacheRead)}  cacheW ${k(t.cacheWrite)}  total ${k(t.totalTokens)}${cost}`,
    `cache-hit ${pct}%  (high=warm/cheap, low=cold → collapsing old context pays)`,
    ctxLine,
  ].join("\n");
}

import type { UsageRow } from "./row.js";

export interface UsageSummary {
  turns: number;
  sessions: number;
  totals: {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    totalTokens: number; cost: number;
  };
  /** cacheRead / (input + cacheRead + cacheWrite). High = warm cache (cheap);
   *  low = cold cache / lots of fresh writes (collapsing old content pays). */
  cacheHitRatio: number;
  ctx: { first: number | null; last: number | null; max: number | null; window: number | null };
}

export function summarize(rows: UsageRow[]): UsageSummary {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  const sessions = new Set<string>();
  const pcts: number[] = [];
  let firstCtx: number | null = null;
  let lastCtx: number | null = null;
  let maxCtx: number | null = null;
  let window: number | null = null;

  for (const r of rows) {
    sessions.add(r.sessionId);
    totals.input += r.input;
    totals.output += r.output;
    totals.cacheRead += r.cacheRead;
    totals.cacheWrite += r.cacheWrite;
    totals.totalTokens += r.totalTokens;
    totals.cost += r.cost?.total ?? 0;
    if (r.ctxPercent != null) pcts.push(r.ctxPercent);
    if (r.ctxTokens != null) {
      if (firstCtx === null) firstCtx = r.ctxTokens;
      lastCtx = r.ctxTokens;
      maxCtx = maxCtx === null ? r.ctxTokens : Math.max(maxCtx, r.ctxTokens);
    }
    if (r.ctxWindow != null) window = r.ctxWindow;
  }

  const denom = totals.input + totals.cacheRead + totals.cacheWrite;
  const cacheHitRatio = denom > 0 ? totals.cacheRead / denom : 0;

  return {
    turns: rows.length,
    sessions: sessions.size,
    totals,
    cacheHitRatio,
    ctx: { first: firstCtx, last: lastCtx, max: maxCtx, window },
  };
}

/** ctxPercent values across rows, for a sparkline. */
export function ctxPercentSeries(rows: UsageRow[]): number[] {
  return rows.map((r) => r.ctxPercent).filter((v): v is number => v != null);
}

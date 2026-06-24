/**
 * One usage record per assistant turn. Built from a `turn_end` event's
 * assistant message (`message.usage`) plus `pi.getContextUsage()`.
 *
 * The input shapes are intentionally minimal structural types (not PI's full
 * types) so this module is dependency-free and trivially testable. They mirror
 * pi-ai's `Usage` and pi-coding-agent's `ContextUsage`.
 */

export interface CostBreakdown {
  input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
}

export interface UsageRow {
  sessionId: string;
  turnIndex: number;
  ts: string;            // ISO timestamp of when the row was recorded
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: CostBreakdown;
  ctxTokens: number | null;
  ctxWindow: number | null;
  ctxPercent: number | null;
}

interface UsageLike {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number;
  cost?: Partial<CostBreakdown>;
}
interface MessageLike { role?: string; model?: string; usage?: UsageLike }
interface CtxLike { tokens?: number | null; contextWindow?: number | null; percent?: number | null }

const n = (v: number | undefined | null, d = 0): number => (typeof v === "number" ? v : d);

/**
 * Returns a row for an assistant turn, or null for anything we don't record
 * (non-assistant messages, or assistant messages without usage data).
 */
export function usageRowFromEvent(
  sessionId: string,
  turnIndex: number,
  message: MessageLike | undefined,
  ctx: CtxLike | undefined,
  ts: string,
): UsageRow | null {
  if (!message || message.role !== "assistant" || !message.usage) return null;
  const u = message.usage;
  const c = u.cost ?? {};
  return {
    sessionId,
    turnIndex,
    ts,
    model: message.model ?? "unknown",
    input: n(u.input),
    output: n(u.output),
    cacheRead: n(u.cacheRead),
    cacheWrite: n(u.cacheWrite),
    totalTokens: n(u.totalTokens),
    cost: {
      input: n(c.input), output: n(c.output), cacheRead: n(c.cacheRead),
      cacheWrite: n(c.cacheWrite), total: n(c.total),
    },
    ctxTokens: ctx?.tokens ?? null,
    ctxWindow: ctx?.contextWindow ?? null,
    ctxPercent: ctx?.percent ?? null,
  };
}

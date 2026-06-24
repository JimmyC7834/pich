export interface RunState {
  active: boolean;
  project: string;
  iterations: number;   // completed tasks this run
  max: number;
  once: boolean;
  pendingContinue: boolean;
}

export type LoopAction = "idle" | "stop-once" | "stop-max" | "stop-empty" | "continue";

export function loopDecision(s: RunState, hasNext: boolean): LoopAction {
  if (!s.active || !s.pendingContinue) return "idle";
  if (s.once) return "stop-once";
  if (s.iterations >= s.max) return "stop-max";
  if (!hasNext) return "stop-empty";
  return "continue";
}

/**
 * Decide whether to compact before the next iteration, given the current
 * context usage as a percentage of the window (0–100) and a threshold (0–100).
 *
 * Only compact once the context has grown past the threshold — cheap
 * iterations skip the compaction round-trip. Unknown usage (null/undefined,
 * e.g. right after a prior compaction) compacts to stay safe.
 */
export function shouldCompact(percent: number | null | undefined, thresholdPct: number): boolean {
  if (percent === null || percent === undefined) return true;
  return percent >= thresholdPct;
}

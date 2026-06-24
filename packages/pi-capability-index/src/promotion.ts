import type { DB } from "./db.js";
import { topRecentIds } from "./usage.js";

export interface ActiveSetInput {
  loadoutIds: string[];
  sessionIds: Set<string>;
  db: DB;
  ceiling: number;          // max auto-promoted beyond loadout+session
}

export function computeActiveIds(input: ActiveSetInput): string[] {
  const base = new Set<string>([...input.loadoutIds, ...input.sessionIds]);
  const promoted = topRecentIds(input.db, input.ceiling, base);
  return [...base, ...promoted];
}

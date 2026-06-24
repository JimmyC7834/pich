import fs from "node:fs";
import path from "node:path";
import type { UsageRow } from "./row.js";

/** Append one row as a JSON line. Creates the parent directory on first write. */
export function appendRow(file: string, row: UsageRow): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

/** Read all rows. Missing file → []. Malformed lines are skipped (fail-open). */
export function readRows(file: string): UsageRow[] {
  if (!fs.existsSync(file)) return [];
  const out: UsageRow[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as UsageRow); } catch { /* skip bad line */ }
  }
  return out;
}

import type { DB } from "./db.js";

export function recordUsage(db: DB, id: string): void {
  db.prepare(`INSERT INTO usage(id,count,last_used_at) VALUES (?,1,?)
    ON CONFLICT(id) DO UPDATE SET count=count+1, last_used_at=excluded.last_used_at`)
    .run(id, new Date().toISOString());
}

export function topRecentIds(db: DB, limit: number, exclude: Set<string>): string[] {
  const rows = db.prepare("SELECT id FROM usage ORDER BY last_used_at DESC, count DESC LIMIT 200").all() as { id: string }[];
  const out: string[] = [];
  for (const r of rows) { if (exclude.has(r.id)) continue; out.push(r.id); if (out.length >= limit) break; }
  return out;
}

/**
 * Record skill usage from a PI `tool_result` event. A skill counts as "used" when
 * its SKILL.md is read. PI's tool_result carries the call args on `event.input`
 * (the read tool's `file_path`); `tool_execution_end` does NOT carry args, so this
 * must be wired to `tool_result`. Best-effort: returns silently on any non-match.
 */
export function recordSkillReadFromEvent(
  db: DB,
  event: { toolName?: string; input?: Record<string, unknown> },
): void {
  if (event?.toolName !== "read") return;
  const fp = String(event.input?.["file_path"] ?? event.input?.["path"] ?? "");
  if (!/(^|[\\/])SKILL\.md$/i.test(fp)) return;
  const seg = fp.replace(/\\/g, "/").split("/");
  const skillName = seg[seg.length - 2];
  if (skillName) recordUsage(db, `skill:${skillName}`);
}

import type { DB } from "./db.js";
import type { Capability } from "./types.js";
import { sha256 } from "./hash.js";

export function upsertCapability(db: DB, cap: Capability): void {
  const hash = sha256(JSON.stringify(cap.searchText) + "|" + JSON.stringify(cap.activation));
  db.prepare(`INSERT INTO capability(id,kind,source,name,summary,params,activation,content_hash,updated_at)
    VALUES (@id,@kind,@source,@name,@summary,@params,@activation,@hash,@now)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, source=excluded.source, name=excluded.name,
      summary=excluded.summary, params=excluded.params, activation=excluded.activation,
      content_hash=excluded.content_hash, updated_at=excluded.updated_at`)
    .run({ id: cap.id, kind: cap.kind, source: cap.source, name: cap.name, summary: cap.summary,
      params: cap.searchText.params, activation: JSON.stringify(cap.activation), hash, now: new Date().toISOString() });
  db.prepare("DELETE FROM capability_fts WHERE id=?").run(cap.id);
  db.prepare("INSERT INTO capability_fts(id,name,summary,params) VALUES (?,?,?,?)")
    .run(cap.id, cap.searchText.name, cap.searchText.summary, cap.searchText.params);
}

export function getCapability(db: DB, id: string): Capability | null {
  const r = db.prepare("SELECT * FROM capability WHERE id=?").get(id) as any;
  return r ? rowToCap(r) : null;
}
export function getCapabilities(db: DB, ids: string[]): Capability[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM capability WHERE id IN (${ph})`).all(...ids) as any[];
  return rows.map(rowToCap);
}
export function deleteCapability(db: DB, id: string): void {
  db.prepare("DELETE FROM capability WHERE id=?").run(id);
  db.prepare("DELETE FROM capability_fts WHERE id=?").run(id);
}
export function allIds(db: DB): string[] {
  return (db.prepare("SELECT id FROM capability ORDER BY id").all() as any[]).map((r) => r.id);
}
export function countByKind(db: DB): Record<string, number> {
  const rows = db.prepare("SELECT kind, count(*) AS n FROM capability GROUP BY kind").all() as { kind: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

function rowToCap(r: any): Capability {
  return { id: r.id, kind: r.kind, source: r.source, name: r.name, summary: r.summary,
    searchText: { name: r.name, summary: r.summary, params: r.params ?? "" },
    activation: safeJson(r.activation, {}) };
}
function safeJson<T>(s: string, fb: T): T { try { return JSON.parse(s) as T; } catch { return fb; } }

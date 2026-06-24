import type { DB } from "./db.js";
import type { CapHit, CapSearchResult, Kind } from "./types.js";

export interface CapSearchOpts { kind?: Kind | "all"; k?: number; }

interface Row { id: string; kind: Kind; name: string; summary: string; bm: number; }

export function capabilitySearch(db: DB, query: string, opts: CapSearchOpts): CapSearchResult {
  const k = opts.k ?? 8;
  const match = ftsQuery(query);
  let sql = `SELECT f.id, c.kind, c.name, c.summary,
      bm25(capability_fts, 0.0, 8.0, 4.0, 1.0) AS bm
    FROM capability_fts f JOIN capability c ON c.id=f.id
    WHERE capability_fts MATCH @q`;
  const params: Record<string, string> = { q: match };
  if (opts.kind && opts.kind !== "all") { sql += ` AND c.kind=@kind`; params["kind"] = opts.kind; }
  sql += ` ORDER BY bm LIMIT 200`;
  let rows: Row[] = [];
  try { rows = db.prepare(sql).all(params) as unknown as Row[]; } catch { rows = []; }

  // bm25: lower (more negative) is better -> min-max invert to 0..1
  const bms = rows.map((r) => r.bm);
  const min = Math.min(...bms), max = Math.max(...bms);
  const hits: (CapHit & { _n: number })[] = rows.map((r) => {
    const norm = max === min ? 1 : (max - r.bm) / (max - min);
    return { id: r.id, kind: r.kind, name: r.name, summary: r.summary, score: round(norm), _n: norm };
  });
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, k).map(({ _n, ...h }) => h);

  const best = hits.length ? hits[0]._n : 0;
  const confidence = confidenceFor(best);
  const next_steps: string[] = [];
  if (hits.length === 0 || confidence === "low")
    next_steps.push("No strong capability match — broaden the query, drop the kind filter, or it may not exist yet.");
  return { hits: top, confidence: hits.length === 0 ? "low" : confidence, next_steps };
}

// ponytail: tiny hardcoded stopword set, expand only if recall suffers.
// Without this, OR-ing every token (incl. "how"/"a"/"the") lets common-word-heavy
// capabilities dominate bm25 regardless of the real query intent.
const STOP = new Set("a an and are as at be but by do for how i if in is it of on or the to what when where which who why with you your".split(" "));

function ftsQuery(q: string): string {
  const all = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let terms = all.filter((t) => t.length > 1 && !STOP.has(t));
  if (terms.length === 0) terms = all; // all-stopword query: fall back to raw tokens
  return terms.map((t) => `"${t}"`).join(" OR ") || '""';
}
function round(n: number): number { return Math.round(n * 1000) / 1000; }

function confidenceFor(best: number): "high" | "medium" | "low" {
  if (best >= 0.66) return "high";
  if (best >= 0.33) return "medium";
  return "low";
}

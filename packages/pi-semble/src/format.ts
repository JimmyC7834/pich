import type { SembleHit } from "./engine.js";
type AnyHit = SembleHit & { authority?: string; sources?: any[] };
export function formatHits(hits: AnyHit[], opts: { snippets?: boolean } = {}): string {
  if (!hits.length) return "No results.";
  return hits.map((h) => {
    const auth = h.authority ? `  [${h.authority}]` : "";
    const head = `${h.file_path}:${h.start_line}-${h.end_line}  score=${h.score.toFixed(3)}${auth}`;
    return opts.snippets && h.content ? `${head}\n${h.content}` : head;
  }).join("\n");
}

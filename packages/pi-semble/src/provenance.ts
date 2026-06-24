import fs from "node:fs"; import path from "node:path";
import { readMeta } from "./frontmatter.js";
import type { SembleHit } from "./engine.js";

export type KbHit = SembleHit & { authority: string; sources: any[]; doc_id: string; };

/** Drop a leading YAML frontmatter block from a snippet so doc results show prose, not metadata. */
export function stripFrontmatter(s: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(s);
  return m ? s.slice(m[0].length).replace(/^\n+/, "") : s;
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
export function buildSupersededSet(kbDirs: string[]): Set<string> {
  const set = new Set<string>();
  for (const dir of kbDirs) for (const f of walkMd(dir)) {
    const s = readMeta(f).supersedes;
    if (s) set.add(s);
  }
  return set;
}
export function annotateKbHits(hits: SembleHit[], repo: string, superseded: Set<string>): KbHit[] {
  const out: KbHit[] = [];
  for (const h of hits) {
    const meta = readMeta(path.join(repo, h.file_path));
    const doc_id = meta.id || h.file_path;
    if (superseded.has(doc_id)) continue;
    const content = h.content ? (stripFrontmatter(h.content) || undefined) : h.content;
    out.push({ ...h, content, doc_id, authority: meta.authority, sources: meta.sources });
  }
  return out;
}

import fs from "node:fs"; import YAML from "yaml";
export interface DocMeta { id: string; authority: "reference" | "curated" | "agent-note"; sources: any[]; supersedes?: string; }
const FM_RE = /^---\n([\s\S]*?)\n---/;
const AUTH = new Set(["reference", "curated", "agent-note"]);
export function readMeta(absFile: string): DocMeta {
  let raw: Record<string, unknown> = {};
  try {
    const m = FM_RE.exec(fs.readFileSync(absFile, "utf-8"));
    if (m) raw = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  } catch { /* missing/invalid → defaults */ }
  const authority = AUTH.has(String(raw.authority)) ? (raw.authority as DocMeta["authority"]) : "agent-note";
  return {
    id: String(raw.id ?? ""),
    authority,
    sources: Array.isArray(raw.sources) ? (raw.sources as any[]) : [],
    supersedes: raw.supersedes ? String(raw.supersedes) : undefined,
  };
}

/** Serialize a frontmatter object + markdown body into a doc file (write side of readMeta). */
export function serializeDoc(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n${body.replace(/^\n+/, "")}`;
}

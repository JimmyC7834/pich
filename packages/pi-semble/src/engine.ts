import path from "node:path";
import { run } from "./run.js";

export interface SembleHit { file_path: string; start_line: number; end_line: number; score: number; content?: string; }
export interface SembleOpts {
  repo: string; cacheDir: string;
  content?: "code" | "docs" | "config" | "all";
  topK?: number; maxSnippetLines?: number | null; hfHome?: string;
}

const FROM = ["--from", "semble[mcp]", "semble"];

function commonFlags(o: SembleOpts): string[] {
  const f: string[] = [];
  if (o.content) f.push("--content", o.content);
  if (o.topK != null) f.push("-k", String(o.topK));
  if (o.maxSnippetLines !== undefined && o.maxSnippetLines !== null) f.push("--max-snippet-lines", String(o.maxSnippetLines));
  return f;
}

export function buildSearchArgs(query: string, o: SembleOpts): string[] {
  return [...FROM, "search", query, o.repo, ...commonFlags(o)];
}
export function buildRelatedArgs(file: string, line: number, o: SembleOpts): string[] {
  return [...FROM, "find-related", file, String(line), o.repo, ...commonFlags(o)];
}
/** Normalize a file path to the index's native separator (semble stores OS-native paths;
 *  on Windows the index uses backslashes, and find-related matches exactly). */
export function toIndexPath(p: string): string { return path.normalize(p); }

export function parseSembleJson(stdout: string): SembleHit[] {
  try {
    const obj = JSON.parse(stdout.trim());
    if (!obj || !Array.isArray(obj.results)) return [];
    return obj.results as SembleHit[];
  } catch { return []; }
}

function envFor(o: SembleOpts): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, SEMBLE_CACHE_LOCATION: o.cacheDir };
  if (o.hfHome) e.HF_HOME = o.hfHome;
  return e;
}
export async function sembleSearch(query: string, o: SembleOpts, signal?: AbortSignal): Promise<SembleHit[]> {
  const r = await run("uvx", buildSearchArgs(query, o), o.repo, envFor(o), signal);
  return r.code === 0 ? parseSembleJson(r.stdout) : [];
}
export async function sembleFindRelated(file: string, line: number, o: SembleOpts, signal?: AbortSignal): Promise<SembleHit[]> {
  const r = await run("uvx", buildRelatedArgs(file, line, o), o.repo, envFor(o), signal);
  return r.code === 0 ? parseSembleJson(r.stdout) : [];
}

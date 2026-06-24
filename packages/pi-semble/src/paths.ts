import fs from "node:fs"; import os from "node:os"; import path from "node:path";
export function projectCacheDir(root: string): string { return path.join(root, ".pi", "semble"); }
export function globalCacheDir(): string { return path.join(os.homedir(), ".pi", "cache", "semble-global"); }
export function hfHome(): string { return path.join(os.homedir(), ".pi", "cache", "hf"); }
function firstExisting(...dirs: string[]): string | null {
  for (const d of dirs) { try { if (fs.statSync(d).isDirectory()) return d; } catch { /* missing */ } }
  return null;
}
export function projectKbDir(root: string): string | null {
  return firstExisting(path.join(root, ".pi", "kb"), path.join(root, "kb"));
}
export function globalKbDir(): string | null {
  return firstExisting(path.join(os.homedir(), ".pi", "kb"));
}
// Write-side roots (created on demand by kb_ingest; the read-side *Dir helpers above
// only return existing dirs). Project docs land where kb_search's projectKbDir looks first.
export function projectKbWriteRoot(root: string): string { return path.join(root, ".pi", "kb"); }
export function globalKbWriteRoot(): string { return path.join(os.homedir(), ".pi", "kb"); }

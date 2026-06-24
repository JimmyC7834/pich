import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs"; import path from "node:path";
import { projectKbDir, globalKbDir } from "./paths.js";

export interface Targets { repoRoot: string; isCode: boolean; projectKb: string | null; globalKb: string | null; }

const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json"];
const SRC_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".c", ".cpp", ".cs", ".php"]);

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "target", "__pycache__", ".pi"]);

function git(root: string, args: string[]): string | null {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trim(); } catch { return null; }
}
function repoRoot(cwd: string): string {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return top ? path.normalize(top) : cwd;
}
/** Bounded recursive scan for a source file, skipping noise dirs. Used when not a git repo. */
function walkForSource(dir: string, depth: number): boolean {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && SRC_EXT.has(path.extname(e.name).toLowerCase())) return true;
  }
  if (depth <= 0) return false;
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && walkForSource(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}
/** Does the repo contain source ANYWHERE (not just the top level)? Git-aware (tracked files), else bounded walk. */
function hasSource(root: string): boolean {
  const tracked = git(root, ["ls-files"]);
  if (tracked !== null) {
    return tracked.length > 0 && tracked.split("\n").some((f) => SRC_EXT.has(path.extname(f).toLowerCase()));
  }
  return walkForSource(root, 4);
}
export function detectTargets(cwd: string): Targets {
  const root = repoRoot(cwd);
  const isCode = MANIFESTS.some((m) => fs.existsSync(path.join(root, m))) || hasSource(root);
  return { repoRoot: root, isCode, projectKb: projectKbDir(root), globalKb: globalKbDir() };
}
export function freshnessSignal(root: string): string {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head === null) return "nogit";
  const porcelain = git(root, ["status", "--porcelain"]) ?? "";
  return head + ":" + createHash("sha256").update(porcelain).digest("hex").slice(0, 16);
}

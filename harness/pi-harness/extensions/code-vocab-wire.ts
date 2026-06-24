import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";


/**
 * code-vocab wiring.
 *
 *  session_start       — (re)build the atlas index for the current repo into
 *                        <root>/.pi/code-vocab/ when stale or missing. If the
 *                        repo has no code (ctags finds 0 symbols → files
 *                        indexed=0), NO artifacts are kept (Option B): the dir
 *                        is removed, so non-code repos stay clean and nothing
 *                        is injected.
 *  before_agent_start  — if a built atlas exists, append the usage contract +
 *                        atlas to the system prompt (idempotent per turn,
 *                        survives compaction — same mechanism memory.ts uses).
 *  tool_call           — one-shot: detect read/grep/find/bash used for code
 *                        discovery and block it, injecting a shot that teaches
 *                        vocab_find/vocab_usages instead.
 *
 *  Tools: `vocab_find` (definitions) and `vocab_usages` (call-sites) wrap
 *  vocab_find.py so lookups render as clean tool calls in the chat instead of
 *  long `python …vocab_find.py …` bash lines. Disable all with CODE_VOCAB_DISABLE=1.

 *
 *  [UPDATED 2026-06-20] Atlas injection, vocab_find, and the discovery guard
 *  were removed — pi-semble's repo_search replaces them. The ctags build and
 *  vocab_usages remain. Closing this block comment also fixes a pre-existing
 *  bug: it was unterminated, swallowing the PKG/CTAGS/... constants below.
 */

// code-vocab tooling ships next to this file (../code-vocab in the umbrella),
// so resolve it relative to the module — works wherever the package installs.
const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "code-vocab");
const CTAGS = path.join(PKG, "bin", "ctags.exe");
const MAKE_VOCAB = path.join(PKG, "make_vocab.py");
const VOCAB_FIND = path.join(PKG, "vocab_find.py");

const CTAGS_ARGS = [
  "--recurse", "--output-format=json", "--fields=+nKzS",
  "--languages=Python,JavaScript,TypeScript,Go,Rust,Java,Kotlin,Ruby,C,C++,C#,PHP,Lua",
  "--links=no",
  "--exclude=.git", "--exclude=.pi", "--exclude=node_modules", "--exclude=.venv",
  "--exclude=venv", "--exclude=dist", "--exclude=build",
  "--exclude=target", "--exclude=__pycache__",
  "--exclude=*.egg-info", "--exclude=*.min.js", "--exclude=*.log",
  "--exclude=package-lock.json", "--exclude=yarn.lock",
  "--exclude=pnpm-lock.yaml", "--exclude=*.bundle.js",
];

interface RunResult { code: number | null; stdout: string; stderr: string; }

/** Spawn a command, capture utf-8 stdout/stderr, never throw (resolve on close/error). */
function run(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, signal });
    } catch (e: any) {
      resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) });
      return;
    }
    proc.stdout?.on("data", (d) => (stdout += d.toString("utf-8")));
    proc.stderr?.on("data", (d) => (stderr += d.toString("utf-8")));
    proc.on("error", (e: any) => resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e) }));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** git output for a repo, or null if not a git repo / git missing. */
async function git(root: string, args: string[]): Promise<string | null> {
  const r = await run("git", args, root);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

/** Resolve the repo root (git toplevel) for a starting dir, else the dir itself.
 *  Memoized per start dir — before_agent_start fires every turn and we don't want
 *  to spawn `git` on each one. */
const _rootCache = new Map<string, string>();
async function repoRoot(start: string): Promise<string> {
  const cached = _rootCache.get(start);
  if (cached) return cached;
  const top = await git(start, ["rev-parse", "--show-toplevel"]);
  const root = top ? path.normalize(top) : start;
  _rootCache.set(start, root);
  return root;
}

/** A cheap freshness signal: HEAD sha + hash of the working-tree status.
 *  Changes whenever a commit lands or any file is edited. "nogit" when not a
 *  git repo (then we only rebuild when the atlas is missing). */
async function freshnessSignal(root: string): Promise<string> {
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (head === null) return "nogit";
  const porcelain = (await git(root, ["status", "--porcelain"])) ?? "";
  return head + ":" + createHash("sha256").update(porcelain).digest("hex").slice(0, 16);
}

function artifactDir(root: string): string { return path.join(root, ".pi", "code-vocab"); }

/** Build (or rebuild) the atlas. Returns filesIndexed, or -1 on failure. */
async function build(root: string): Promise<number> {
  const dir = artifactDir(root);
  const tags = path.join(dir, "tags.json");
  const vocab = path.join(dir, "vocabulary.md");
  fs.mkdirSync(dir, { recursive: true });
  // Delete stale artifacts — Universal-ctags refuses to overwrite a file that
  // doesn't have the traditional !_TAG_ magic header (our JSON output doesn't).
  try { fs.rmSync(tags); fs.rmSync(tags + ".cache"); } catch {}
  // ctags must run from `root` with `.` so tag paths are RELATIVE; -f may be absolute.
  const ct = await run(CTAGS, [...CTAGS_ARGS, "-f", tags, "."], root);
  if (ct.code !== 0) return -1;

  const mk = await run("python", [
    MAKE_VOCAB, "--root", root, "--tags", tags, "--mode", "atlas", "--out", vocab,
  ], root);
  if (mk.code !== 0) return -1;

  // make_vocab prints "... files indexed=N)" — that N is our "is it code?" signal.
  const m = mk.stdout.match(/files indexed=(\d+)/);
  return m ? Number(m[1]) : -1;
}

function writeMeta(root: string, signal: string, filesIndexed: number): void {
  const dir = artifactDir(root);
  try {
    // Self-contained ignore: keep the whole artifact dir out of git (matches
    // pi-research-library's per-dir .gitignore convention).
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", "utf-8");
    fs.writeFileSync(path.join(dir, "meta.json"),
      JSON.stringify({ signal, filesIndexed, builtAt: new Date().toISOString() }), "utf-8");
  } catch { /* ignore */ }
}

function readMetaSignal(root: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(artifactDir(root), "meta.json"), "utf-8"));
    return typeof meta.signal === "string" ? meta.signal : null;
  } catch { return null; }
}

// The PageRank atlas is no longer injected into the system prompt — pi-semble's
// repo_search covers code discovery. make_vocab.py + the atlas build are kept
// (tags.json feeds vocab_usages; the atlas can return as an on-demand tool later).

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** Resolve {root, tags} for the active repo's index, or null if not built. */
async function indexOrNull(): Promise<{ root: string; tags: string } | null> {
  const root = await repoRoot(process.cwd());
  const tags = path.join(artifactDir(root), "tags.json");
  return fs.existsSync(tags) ? { root, tags } : null;
}

export default function (pi: ExtensionAPI) {
  if (process.env["CODE_VOCAB_DISABLE"]) return;

  // Build/refresh once per session.
  pi.on("session_start", async () => {
    try {
      const root = await repoRoot(process.cwd());
      const dir = artifactDir(root);
      const vocab = path.join(dir, "vocabulary.md");
      const signal = await freshnessSignal(root);

      // Fresh: atlas present and signal unchanged → nothing to do.
      if (fs.existsSync(vocab) && readMetaSignal(root) === signal && signal !== "nogit") return;
      // Non-git repo: only build when the atlas is missing (can't detect staleness cheaply).
      if (signal === "nogit" && fs.existsSync(vocab)) return;

      const n = await build(root);
      if (n > 0) {
        writeMeta(root, signal, n);            // code project → keep + remember signal
      } else {
        // Option B: no code (or build failed) → keep nothing, leave the repo clean.
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch { /* fail-open: never block session start */ }
  });

  // vocab_usages — all call-sites of a symbol (ripgrep), grouped, file:line out.
  pi.registerTool({
    name: "vocab_usages",
    label: "Vocab Usages",
    description:
      "Find ALL usages / call-sites of a symbol in THIS repo via ripgrep (whole-word). Returns every match as file:line grouped by file. Use before renaming, or to see who calls something. For the definition use vocab_find.",
    promptSnippet: "find all usages/call-sites of a symbol in this repo (file:line)",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol to find all usages of." }),
      scope: Type.Optional(Type.String({ description: "Limit to a folder/path prefix." })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)." })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      try {
        const q = String(p?.query ?? "").trim();
        if (!q) return out("Provide a query (symbol to find usages of).");
        const idx = await indexOrNull();
        if (!idx) return out("code-vocab index not built for this repo (not a coding project, or no session has indexed it yet).");
        const args = [VOCAB_FIND, "--tags", idx.tags, "--usages", "--root", "."];
        if (p?.scope) args.push("--scope", String(p.scope));
        if (p?.limit) args.push("--limit", String(Number(p.limit)));
        args.push(q);
        const r = await run("python", args, idx.root, signal);
        return out(r.stdout.trim() || r.stderr.trim() || "(no output)");
      } catch (e: any) {
        return out(`vocab_usages failed: ${e?.message ?? String(e)}`);
      }
    },
  } as any);

  // ── Strip verbose anchor blocks from edit tool results ──
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "edit" || event.isError) return;
    return { content: [{ type: "text", text: "edit applied" }] };
  });

}

# Semble Search Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the lexical search backends of `code-vocab` (ctags `vocab_find`) and `pi-research-library` (SQLite FTS5 `kb_search`) with a single hybrid (semantic + lexical + code-aware-rerank) engine — [MinishLab/semble](https://github.com/MinishLab/semble) — exposed to the pi agent as native tools, indexing both repo code and the markdown doc library, with project- and global-scoped doc indexes.

**Architecture:** A new TypeScript pi extension `pi-semble` shells out to semble (installed on demand via `uvx`), parsing its JSON output. A transport-abstracted `engine` module backs three retrieval tools (`code_search`, `kb_search`, `find_related`); a `provenance` post-pass re-adds supersession-hiding + authority/source annotation that semble (pure retrieval) doesn't know about; a `detect` module decides what to index and a session-start warm-up builds the on-disk cache lazily. The semble index cache lives in `.pi/semble/` (project) and `~/.pi/cache/semble-global/` (global); the embedding model lives in a shared `~/.pi/cache/hf/`. The old SQLite/ctags search code is retired; `code-vocab`'s PageRank atlas injection and `vocab_usages` are kept.

**Tech Stack:** TypeScript (run via pi's jiti, no build), `typebox` (tool schemas), `yaml` (frontmatter), `vitest` (tests), Node 20. External engine: `semble[mcp]` (Python ≥3.10) invoked through `uvx`.

> **Naming update (post-authoring):** the local code-search tool is registered as **`repo_search`**, not `code_search` — `pi-web-tools` already owns `code_search` (web/GitHub examples). Read every `code_search` below as `repo_search`. Likewise the old FTS5 `kb_search` in `pi-research-library` is already unregistered (that dir is git-ignored, so its retirement is plain file deletion, not `git rm`).

## Global Constraints

- **Engine invocation (verbatim, spike-verified):**
  - CLI search: `uvx --from "semble[mcp]" semble search "<query>" "<absPath>" --content <code|docs|config|all> -k <N> --max-snippet-lines <M>`
  - CLI find-related: `uvx --from "semble[mcp]" semble find-related "<file_path>" <line> "<absPath>" -k <N> --max-snippet-lines <M>`
  - Warm MCP server (deferred Phase 8): `uvx --from "semble[mcp]" semble "<absPath>" --content all` (bare `semble` + non-subcommand path → stdio MCP server).
- **`semble` requires ABSOLUTE paths** for the repo/path argument (relative paths silently fail with `Path does not exist`).
- **JSON output shape** (stdout, non-TTY): `{"query": "...", "results": [{"file_path": "rel/to/repo", "start_line": N, "end_line": N, "score": F, "content": "..."}]}`; or `{"error": "..."}`. `content` is omitted when `--max-snippet-lines 0`. `file_path` is **relative to the searched path**.
- **Cache location** is set per-process via env `SEMBLE_CACHE_LOCATION=<absDir>`; the embedding model downloads to `HF_HOME=<absDir>`. Both must be absolute.
- **`--content` is per-call in CLI mode** (used here); it becomes per-server only in the deferred warm-MCP phase.
- **Fail-open everywhere:** no hook (`session_start`, `tool_call`, `before_agent_start`) may ever throw or block — semble is an optimization, not a dependency.
- **Windows-first:** dev/target OS is Windows 10; `uvx` is on PATH. Never assume POSIX-only tooling.
- TypeScript strict; ESM (`"type": "module"`); tools registered via `pi.registerTool`; `Type` from `typebox` for schemas.

---

## Feasibility (already verified — do not re-litigate)

A Phase-0 spike on the target Windows machine confirmed:

- `uvx --from "semble[mcp]" semble` installs cleanly (64 packages, ~21 s, no compiler).
- First search (cold, incl. model download) ~18 s; warm re-search ~1.4 s **dominated by Python/uvx process startup** — the query itself is sub-ms. (This is why warm-MCP is the eventual optimization, but CLI-spawn is the simple, correct Phase-1 transport.)
- `SEMBLE_CACHE_LOCATION` is honored: the index landed in `<dir>/<pathhash>/index/{bm25_index, semantic_index, chunks.json, metadata.json}`, **748 KB** for a ~15-file folder (full repo → low tens of MB).
- `--content docs` correctly returned only the markdown file; `--content code` only source.
- `find-related` returned semantically-related code (score 0.80).
- CLI emits clean JSON on a pipe — **no `--json` flag needed**.
- Model (`potion-code-16M`, 256-dim, ~62.5k vocab ≈ ~64 MB) downloads to the HF cache, redirectable via `HF_HOME`.

---

## File structure

```
~/.pi/agent/extensions/pi-semble/
  package.json            # type:module, pi.extensions, deps (typebox, yaml; dev vitest, ts)
  tsconfig.json
  index.ts                # ExtensionFactory: register tools + guard; session_start warm; teardown
  src/
    engine.ts             # transport-abstracted: sembleSearch / sembleFindRelated (Phase 1: CLI spawn)
    run.ts                # spawn helper (capture stdout/stderr, never throw) — copied from code-vocab-wire
    paths.ts              # repoRoot, projectCacheDir, globalCacheDir, hfHome, projectKbDir, globalKbDir
    detect.ts             # detectTargets(cwd) + freshnessSignal(root)
    frontmatter.ts        # minimal YAML frontmatter reader (id, authority, sources, supersedes)
    provenance.ts         # buildSupersededSet + annotateKbHits (supersession filter + authority/source)
    format.ts             # render hits → agent-facing text block
    guard.ts              # tool_call handler: teach code_search/kb_search over manual grep/read
    tools/
      code_search.ts kb_search.ts find_related.ts
  test/                   # *.test.ts (vitest); engine.int.test.ts is uvx-gated (skips if absent)
```

**Module boundaries:** `engine`/`run` own process spawning. `paths`/`detect`/`frontmatter`/`provenance`/`format` are pure (no spawning, trivially testable). `tools/*` compose engine + provenance + format. `index.ts` is the only file touching `ExtensionAPI`.

**Migrations (separate extensions, Phase 6–7):**
- `agent/extensions/code-vocab-wire.ts` — trimmed to atlas build/injection + `vocab_usages`; drop `vocab_find` + the manual-discovery guard (moves to `pi-semble`).
- `agent/extensions/pi-research-library/` — drop SQLite search (`db/schema/indexer/search/chunker/registry`), the `session_start` reindex, and the `kb_search` tool/registration; keep all curation tools, `frontmatter`, `paths`, `secrets`, `types`, `policy`, `commands`.

---

## Key architecture decisions (rationale)

1. **CLI-spawn transport first, warm-MCP later.** The spike proved CLI JSON works and the only cost is ~1.4 s process startup. CLI-spawn needs **no MCP client, no long-lived process, no teardown** — the on-disk cache is the persistence. Warm-MCP (sub-100 ms queries) is a pure internal swap behind the same `engine` interface (Phase 8, deferred). This ships working software at Phase 5.
2. **Two cache scopes, set by env per spawn.** Project index → `<root>/.pi/semble/` (ephemeral, git-ignored, dies with project). Global doc index → `~/.pi/cache/semble-global/` (built once, shared across projects). Model → `~/.pi/cache/hf/` (shared). One `SEMBLE_CACHE_LOCATION` per spawn selects the scope.
3. **Provenance post-pass on `kb_search` only.** Semble returns relevance only. The wrapper reads frontmatter of the **returned top-k** doc files to drop superseded docs and annotate `authority`/`sources` — recovering pi-research-library's trust signals at ~1% of the SQLite weight. Code hits have no frontmatter → skipped.
4. **No fuzzy/typo pre-pass.** Semble's static-embedding semantic side already covers paraphrase/concept fuzz; the old Levenshtein expander is dropped (decision locked with user).
5. **Atlas kept.** Semble is retrieval, not structural understanding; `code-vocab`'s PageRank atlas injection stays as orientation. `vocab_usages` (exhaustive ripgrep call-sites) kept — semble returns *ranked*, not *every*, occurrence.

---

## Task 1: Scaffold + engine arg-building (pure)

**Files:**
- Create: `agent/extensions/pi-semble/package.json`, `tsconfig.json`
- Create: `agent/extensions/pi-semble/src/engine.ts`
- Test: `agent/extensions/pi-semble/test/engine.test.ts`

**Interfaces:**
- Produces: `SembleHit { file_path: string; start_line: number; end_line: number; score: number; content?: string }`; `SembleOpts { repo: string; cacheDir: string; content?: "code"|"docs"|"config"|"all"; topK?: number; maxSnippetLines?: number|null; hfHome?: string }`; `buildSearchArgs(query: string, o: SembleOpts): string[]`; `buildRelatedArgs(file: string, line: number, o: SembleOpts): string[]`; `parseSembleJson(stdout: string): SembleHit[]`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pi-semble",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "vitest run", "build": "echo none", "check": "tsc --noEmit" },
  "dependencies": { "typebox": "^1.1.24", "yaml": "^2.6.0" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.2",
    "@types/node": "^20.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "types": ["node"], "noEmit": true
  },
  "include": ["index.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: `npm install`**

Run: `cd ~/.pi/agent/extensions/pi-semble && npm install`
Expected: completes (no native builds).

- [ ] **Step 4: Write the failing test** — `test/engine.test.ts`

```ts
import { test, expect } from "vitest";
import { buildSearchArgs, buildRelatedArgs, parseSembleJson } from "../src/engine.js";

test("buildSearchArgs produces a semble search invocation", () => {
  const args = buildSearchArgs("retry backoff", {
    repo: "C:/proj", cacheDir: "C:/proj/.pi/semble", content: "code", topK: 3, maxSnippetLines: 4,
  });
  expect(args.slice(0, 5)).toEqual(["--from", "semble[mcp]", "semble", "search", "retry backoff"]);
  expect(args).toContain("C:/proj");
  expect(args).toEqual(expect.arrayContaining(["--content", "code", "-k", "3", "--max-snippet-lines", "4"]));
});

test("buildRelatedArgs produces a find-related invocation", () => {
  const args = buildRelatedArgs("a.py", 12, { repo: "C:/proj", cacheDir: "C:/c", topK: 2, maxSnippetLines: 0 });
  expect(args.slice(0, 4)).toEqual(["--from", "semble[mcp]", "semble", "find-related"]);
  expect(args).toEqual(expect.arrayContaining(["a.py", "12", "C:/proj", "-k", "2", "--max-snippet-lines", "0"]));
});

test("parseSembleJson reads results and tolerates error/empty", () => {
  const hits = parseSembleJson('{"query":"q","results":[{"file_path":"a.ts","start_line":1,"end_line":9,"score":0.5,"content":"x"}]}');
  expect(hits).toHaveLength(1);
  expect(hits[0].file_path).toBe("a.ts");
  expect(parseSembleJson('{"error":"No results found."}')).toEqual([]);
  expect(parseSembleJson("garbage")).toEqual([]);
});
```

- [ ] **Step 5: Verify fail** — `npx vitest run test/engine.test.ts` → FAIL (module missing).

- [ ] **Step 6: Implement `src/engine.ts` (pure parts only this task)**

```ts
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
export function parseSembleJson(stdout: string): SembleHit[] {
  try {
    const obj = JSON.parse(stdout.trim());
    if (!obj || !Array.isArray(obj.results)) return [];
    return obj.results as SembleHit[];
  } catch { return []; }
}
```

- [ ] **Step 7: Verify pass** — `npx vitest run test/engine.test.ts` → 3 passed.
- [ ] **Step 8: Commit**

```bash
git add agent/extensions/pi-semble/package.json agent/extensions/pi-semble/tsconfig.json agent/extensions/pi-semble/src/engine.ts agent/extensions/pi-semble/test/engine.test.ts
git commit -m "feat(semble): scaffold pi-semble + pure engine arg/JSON helpers"
```

---

## Task 2: Spawn helper + live engine calls (integration, uvx-gated)

**Files:**
- Create: `agent/extensions/pi-semble/src/run.ts`
- Modify: `agent/extensions/pi-semble/src/engine.ts`
- Test: `agent/extensions/pi-semble/test/engine.int.test.ts`

**Interfaces:**
- Produces: `run(cmd, args, cwd?, env?, signal?): Promise<{code:number|null; stdout:string; stderr:string}>`; `sembleSearch(query: string, o: SembleOpts, signal?: AbortSignal): Promise<SembleHit[]>`; `sembleFindRelated(file: string, line: number, o: SembleOpts, signal?: AbortSignal): Promise<SembleHit[]>`. Both spawn `uvx` with `SEMBLE_CACHE_LOCATION=o.cacheDir` (+ `HF_HOME=o.hfHome` when set) and return `parseSembleJson(stdout)` (or `[]` on non-zero exit).

- [ ] **Step 1: Implement `src/run.ts`** (copied pattern from `code-vocab-wire.ts`)

```ts
import { spawn } from "node:child_process";
export interface RunResult { code: number | null; stdout: string; stderr: string; }
export function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", proc;
    try { proc = spawn(cmd, args, { cwd, env: env ?? process.env, signal }); }
    catch (e: any) { resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) }); return; }
    proc.stdout?.on("data", (d) => (stdout += d.toString("utf-8")));
    proc.stderr?.on("data", (d) => (stderr += d.toString("utf-8")));
    proc.on("error", (e: any) => resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e) }));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
```

- [ ] **Step 2: Add live callers to `src/engine.ts`**

```ts
import { run } from "./run.js";

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
```

- [ ] **Step 3: Write the uvx-gated integration test** — `test/engine.int.test.ts`

```ts
import { test, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { sembleSearch } from "../src/engine.js";

function hasUvx(): boolean { try { execSync("uvx --version", { stdio: "ignore" }); return true; } catch { return false; } }
const maybe = hasUvx() ? test : test.skip;

maybe("sembleSearch indexes a temp repo and returns a relevant hit", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "semble-it-"));
  fs.writeFileSync(path.join(repo, "auth.ts"), "export function authenticateUser(token: string){ return verify(token); }\n");
  const cacheDir = path.join(repo, ".pi", "semble");
  const hits = await sembleSearch("authenticate a user with a token", {
    repo, cacheDir, content: "code", topK: 3, maxSnippetLines: 0,
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some(h => h.file_path.includes("auth.ts"))).toBe(true);
  fs.rmSync(repo, { recursive: true, force: true });
}, 120_000);
```

- [ ] **Step 4: Run** — `npx vitest run test/engine.int.test.ts` → 1 passed (or skipped if `uvx` absent; on the target machine it must PASS).
- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-semble/src/run.ts agent/extensions/pi-semble/src/engine.ts agent/extensions/pi-semble/test/engine.int.test.ts
git commit -m "feat(semble): live engine (uvx spawn + cache/model env)"
```

---

## Task 3: Paths + target detection + freshness

**Files:**
- Create: `agent/extensions/pi-semble/src/paths.ts`, `src/detect.ts`
- Test: `agent/extensions/pi-semble/test/detect.test.ts`

**Interfaces:**
- Produces (`paths.ts`): `projectCacheDir(root): string` → `<root>/.pi/semble`; `globalCacheDir(): string` → `<home>/.pi/cache/semble-global`; `hfHome(): string` → `<home>/.pi/cache/hf`; `projectKbDir(root): string|null` (`<root>/.pi/kb` or `<root>/kb` if exists); `globalKbDir(): string|null` (`<home>/.pi/kb` if exists).
- Produces (`detect.ts`): `Targets { repoRoot: string; isCode: boolean; projectKb: string|null; globalKb: string|null }`; `detectTargets(cwd: string): Targets`; `freshnessSignal(root: string): string` (HEAD sha + hash of `git status --porcelain`, `"nogit"` fallback).

- [ ] **Step 1: Failing test** — `test/detect.test.ts`

```ts
import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { projectCacheDir, globalCacheDir, hfHome } from "../src/paths.js";
import { detectTargets } from "../src/detect.js";

test("cache paths resolve under .pi", () => {
  expect(projectCacheDir("C:/p")).toBe(path.join("C:/p", ".pi", "semble"));
  expect(globalCacheDir()).toBe(path.join(os.homedir(), ".pi", "cache", "semble-global"));
  expect(hfHome()).toBe(path.join(os.homedir(), ".pi", "cache", "hf"));
});

test("detectTargets marks a manifest dir as code and finds project kb", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.mkdirSync(path.join(root, "kb"), { recursive: true });
  const t = detectTargets(root);
  expect(t.isCode).toBe(true);
  expect(t.projectKb).toBe(path.join(root, "kb"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("detectTargets marks an empty dir as non-code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "det2-"));
  expect(detectTargets(root).isCode).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/detect.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/paths.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/detect.ts`**

```ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs"; import path from "node:path";
import { projectKbDir, globalKbDir } from "./paths.js";

export interface Targets { repoRoot: string; isCode: boolean; projectKb: string | null; globalKb: string | null; }

const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json"];
const SRC_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".c", ".cpp", ".cs", ".php"]);

function git(root: string, args: string[]): string | null {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim(); } catch { return null; }
}
function repoRoot(cwd: string): string {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return top ? path.normalize(top) : cwd;
}
function hasSource(root: string): boolean {
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && SRC_EXT.has(path.extname(e.name).toLowerCase())) return true;
    }
  } catch { /* unreadable */ }
  return false;
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
```

- [ ] **Step 5: Verify pass + commit**

Run: `npx vitest run test/detect.test.ts` → 3 passed.
```bash
git add agent/extensions/pi-semble/src/paths.ts agent/extensions/pi-semble/src/detect.ts agent/extensions/pi-semble/test/detect.test.ts
git commit -m "feat(semble): cache paths + repo/kb detection + freshness"
```

---

## Task 4: Frontmatter reader + provenance post-pass

**Files:**
- Create: `agent/extensions/pi-semble/src/frontmatter.ts`, `src/provenance.ts`
- Test: `agent/extensions/pi-semble/test/provenance.test.ts`

**Interfaces:**
- Produces (`frontmatter.ts`): `DocMeta { id: string; authority: "reference"|"curated"|"agent-note"; sources: any[]; supersedes?: string }`; `readMeta(absFile: string): DocMeta` (returns defaults if no/invalid frontmatter).
- Produces (`provenance.ts`): `KbHit = SembleHit & { authority: string; sources: any[]; doc_id: string }`; `buildSupersededSet(kbDirs: string[]): Set<string>` (ids that appear as any doc's `supersedes`); `annotateKbHits(hits: SembleHit[], repo: string, superseded: Set<string>): KbHit[]` (reads each hit file's frontmatter relative to `repo`, drops hits whose `doc_id ∈ superseded`, attaches authority/sources).

- [ ] **Step 1: Failing test** — `test/provenance.test.ts`

```ts
import { test, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { buildSupersededSet, annotateKbHits } from "../src/provenance.js";

function mkKb(): { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  fs.writeFileSync(path.join(dir, "v1.md"), `---\nid: backoff-v1\nauthority: agent-note\n---\nold backoff\n`);
  fs.writeFileSync(path.join(dir, "v2.md"), `---\nid: backoff-v2\nauthority: reference\nsupersedes: backoff-v1\nsources:\n  - url: https://x\n---\nnew backoff\n`);
  return { dir };
}

test("buildSupersededSet collects superseded ids", () => {
  const { dir } = mkKb();
  expect(buildSupersededSet([dir]).has("backoff-v1")).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("annotateKbHits drops superseded and annotates authority/sources", () => {
  const { dir } = mkKb();
  const superseded = buildSupersededSet([dir]);
  const hits = [
    { file_path: "v1.md", start_line: 1, end_line: 2, score: 0.9 },
    { file_path: "v2.md", start_line: 1, end_line: 2, score: 0.8 },
  ];
  const out = annotateKbHits(hits, dir, superseded);
  expect(out).toHaveLength(1);
  expect(out[0].doc_id).toBe("backoff-v2");
  expect(out[0].authority).toBe("reference");
  expect(out[0].sources[0].url).toBe("https://x");
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/provenance.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/frontmatter.ts`**

```ts
import fs from "node:fs"; import YAML from "yaml";
export interface DocMeta { id: string; authority: "reference"|"curated"|"agent-note"; sources: any[]; supersedes?: string; }
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
```

- [ ] **Step 4: Implement `src/provenance.ts`**

```ts
import fs from "node:fs"; import path from "node:path";
import { readMeta } from "./frontmatter.js";
import type { SembleHit } from "./engine.js";

export type KbHit = SembleHit & { authority: string; sources: any[]; doc_id: string; };

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
    out.push({ ...h, doc_id, authority: meta.authority, sources: meta.sources });
  }
  return out;
}
```

- [ ] **Step 5: Verify pass + commit**

Run: `npx vitest run test/provenance.test.ts` → 2 passed.
```bash
git add agent/extensions/pi-semble/src/frontmatter.ts agent/extensions/pi-semble/src/provenance.ts agent/extensions/pi-semble/test/provenance.test.ts
git commit -m "feat(semble): frontmatter reader + supersession/authority post-pass"
```

---

## Task 5: Result formatting + the three tools

**Files:**
- Create: `agent/extensions/pi-semble/src/format.ts`, `src/tools/code_search.ts`, `src/tools/kb_search.ts`, `src/tools/find_related.ts`
- Test: `agent/extensions/pi-semble/test/format.test.ts`

**Interfaces:**
- Consumes: `engine.sembleSearch/sembleFindRelated/SembleHit`; `paths.*`; `detect.detectTargets`; `provenance.buildSupersededSet/annotateKbHits/KbHit`.
- Produces (`format.ts`): `formatHits(hits, opts?): string` (one line per hit: `path:start-end  score=…  [authority]` + optional snippet). Tool factories `makeCodeSearch()`, `makeKbSearch()`, `makeFindRelated()` returning pi tool definitions; each `execute` resolves targets from `process.cwd()` and returns `{ content: [{type:"text", text}], details:{} }`.

- [ ] **Step 1: Failing test** — `test/format.test.ts`

```ts
import { test, expect } from "vitest";
import { formatHits } from "../src/format.js";

test("formatHits renders path:line, score, and authority when present", () => {
  const text = formatHits([
    { file_path: "a.ts", start_line: 3, end_line: 9, score: 0.51 } as any,
    { file_path: "b.md", start_line: 1, end_line: 2, score: 0.4, authority: "reference", sources: [{ url: "u" }] } as any,
  ]);
  expect(text).toContain("a.ts:3-9");
  expect(text).toContain("b.md:1-2");
  expect(text).toContain("reference");
});
test("formatHits handles empty", () => { expect(formatHits([])).toMatch(/no results/i); });
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/format.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/format.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/tools/code_search.ts`**

```ts
import { Type } from "typebox";
import { sembleSearch } from "../engine.js";
import { detectTargets } from "../detect.js";
import { projectCacheDir, hfHome } from "../paths.js";
import { formatHits } from "../format.js";

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function makeCodeSearch() {
  return {
    name: "code_search",
    label: "Code Search",
    description: "Hybrid semantic+lexical search over THIS repo's source (semble). Returns file:line ranked chunks — navigate directly, do not grep again. For doc-library search use kb_search; for the definition map use the atlas.",
    promptSnippet: "semantic code search over this repo (file:line)",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or code query (behavior or symbol name)." }),
      top_k: Type.Optional(Type.Number({ description: "Max results (default 6)." })),
      snippets: Type.Optional(Type.Boolean({ description: "Include code snippet lines (default false)." })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const t = detectTargets(process.cwd());
      if (!t.isCode) return out("code_search: not a code repo (nothing indexed).");
      const hits = await sembleSearch(String(p?.query ?? ""), {
        repo: t.repoRoot, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(),
        content: "code", topK: Number(p?.top_k ?? 6), maxSnippetLines: p?.snippets ? null : 0,
      }, signal);
      return out(formatHits(hits, { snippets: !!p?.snippets }));
    },
  };
}
```

- [ ] **Step 5: Implement `src/tools/find_related.ts`**

```ts
import { Type } from "typebox";
import { sembleFindRelated } from "../engine.js";
import { detectTargets } from "../detect.js";
import { projectCacheDir, hfHome } from "../paths.js";
import { formatHits } from "../format.js";
const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function makeFindRelated() {
  return {
    name: "find_related",
    label: "Find Related",
    description: "Find code semantically similar to a specific file:line in THIS repo (semble find_related). Use after code_search to discover sibling implementations, callers, or tests. Pass file_path + line from a prior result.",
    promptSnippet: "find code similar to a file:line",
    parameters: Type.Object({
      file_path: Type.String({ description: "File path as shown in a search result." }),
      line: Type.Number({ description: "1-indexed line number." }),
      top_k: Type.Optional(Type.Number({ description: "Max results (default 5)." })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const t = detectTargets(process.cwd());
      const hits = await sembleFindRelated(String(p?.file_path ?? ""), Number(p?.line ?? 1), {
        repo: t.repoRoot, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(),
        topK: Number(p?.top_k ?? 5), maxSnippetLines: 0,
      }, signal);
      return out(formatHits(hits));
    },
  };
}
```

- [ ] **Step 6: Implement `src/tools/kb_search.ts`**

```ts
import { Type } from "typebox";
import { sembleSearch } from "../engine.js";
import { detectTargets } from "../detect.js";
import { projectCacheDir, globalCacheDir, hfHome } from "../paths.js";
import { buildSupersededSet, annotateKbHits, type KbHit } from "../provenance.js";
import { formatHits } from "../format.js";
const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function makeKbSearch() {
  return {
    name: "kb_search",
    label: "KB Search",
    description: "Search the knowledge library (sourced markdown docs) with hybrid semantic+lexical retrieval (semble). Scope: project, global, or both (default). Returns ranked doc chunks with authority + sources; superseded docs are hidden. To write a sourced note use kb_write.",
    promptSnippet: "search the doc library (project + global)",
    parameters: Type.Object({
      query: Type.String({ description: "What you want to know." }),
      scope: Type.Optional(Type.String({ description: "project | global | both (default both)." })),
      top_k: Type.Optional(Type.Number({ description: "Max results (default 8)." })),
      snippets: Type.Optional(Type.Boolean({ description: "Include doc snippet lines (default true)." })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const t = detectTargets(process.cwd());
      const scope = String(p?.scope ?? "both");
      const topK = Number(p?.top_k ?? 8);
      const snippets = p?.snippets !== false;
      const maxSnippetLines = snippets ? null : 0;
      const wantProject = (scope === "project" || scope === "both") && !!t.projectKb;
      const wantGlobal = (scope === "global" || scope === "both") && !!t.globalKb;

      const all: KbHit[] = [];
      if (wantProject) {
        const hits = await sembleSearch(String(p?.query ?? ""), {
          repo: t.projectKb!, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(),
          content: "docs", topK, maxSnippetLines,
        }, signal);
        all.push(...annotateKbHits(hits, t.projectKb!, buildSupersededSet([t.projectKb!])).map(h => ({ ...h, score: h.score + 0.001 }))); // project tiebreak boost
      }
      if (wantGlobal) {
        const hits = await sembleSearch(String(p?.query ?? ""), {
          repo: t.globalKb!, cacheDir: globalCacheDir(), hfHome: hfHome(),
          content: "docs", topK, maxSnippetLines,
        }, signal);
        all.push(...annotateKbHits(hits, t.globalKb!, buildSupersededSet([t.globalKb!])));
      }
      if (!wantProject && !wantGlobal) return out("kb_search: no knowledge library found (project or global).");
      all.sort((a, b) => b.score - a.score);
      return out(formatHits(all.slice(0, topK), { snippets }));
    },
  };
}
```

- [ ] **Step 7: Verify pass + commit**

Run: `npx vitest run test/format.test.ts` → 2 passed. (Tool `execute` paths are covered by the e2e in Task 7.)
```bash
git add agent/extensions/pi-semble/src/format.ts agent/extensions/pi-semble/src/tools agent/extensions/pi-semble/test/format.test.ts
git commit -m "feat(semble): code_search, kb_search (scoped+provenance), find_related tools"
```

---

## Task 6: Guard (teach the tools) + extension wiring + lazy warm

**Files:**
- Create: `agent/extensions/pi-semble/src/guard.ts`, `agent/extensions/pi-semble/index.ts`
- Test: `agent/extensions/pi-semble/test/guard.test.ts`

**Interfaces:**
- Consumes: tool factories from Task 5; `detect.detectTargets/freshnessSignal`; `paths.*`; `engine.sembleSearch`.
- Produces (`guard.ts`): `classifyDiscovery(toolName: string, input: any): { hit: boolean; hint: string }` (pure — flags manual `read`/`grep`/`find`/`bash` code-discovery). `index.ts` default-exports the `ExtensionAPI` factory.

- [ ] **Step 1: Failing test** — `test/guard.test.ts`

```ts
import { test, expect } from "vitest";
import { classifyDiscovery } from "../src/guard.js";

test("flags grep and source-file reads, ignores node_modules and non-source", () => {
  expect(classifyDiscovery("grep", { query: "authenticate" }).hit).toBe(true);
  expect(classifyDiscovery("read", { path: "src/auth.ts" }).hit).toBe(true);
  expect(classifyDiscovery("read", { path: "node_modules/x/i.ts" }).hit).toBe(false);
  expect(classifyDiscovery("read", { path: "notes.txt" }).hit).toBe(false);
  expect(classifyDiscovery("bash", { command: "rg foo src" }).hit).toBe(true);
  expect(classifyDiscovery("bash", { command: "npm test" }).hit).toBe(false);
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/guard.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/guard.ts`**

```ts
import path from "node:path";
const SOURCE_EXT = new Set([".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".go",".rs",".kt",".java",".rb",".php",".c",".cpp",".h",".hpp",".cs",".swift",".scala"]);
export function classifyDiscovery(toolName: string, input: any): { hit: boolean; hint: string } {
  const inNM = (s?: string) => !!s && s.includes("node_modules");
  if (toolName === "read") {
    const p = String(input?.path ?? ""); const ext = path.extname(p).toLowerCase();
    if (ext && SOURCE_EXT.has(ext) && !inNM(p)) return { hit: true, hint: `read ${p}` };
  } else if (toolName === "grep") {
    if (input?.query && !inNM(input?.path)) return { hit: true, hint: `grep "${input.query}"` };
  } else if (toolName === "find") {
    if (input?.pattern && !inNM(input?.path)) return { hit: true, hint: `find ${input.pattern}` };
  } else if (toolName === "bash") {
    const cmd = String(input?.command ?? "").trim();
    if (/^(?:grep|rg|ag|find|ls|cat|head|tail)\b/.test(cmd) && !cmd.includes("node_modules") && !cmd.includes("package.json")) {
      return { hit: true, hint: cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd };
    }
  }
  return { hit: false, hint: "" };
}
```

- [ ] **Step 4: Implement `index.ts`** (wiring; fail-open; one-shot guard via file sentinel like code-vocab)

```ts
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import fs from "node:fs"; import path from "node:path";
import { makeCodeSearch } from "./src/tools/code_search.js";
import { makeKbSearch } from "./src/tools/kb_search.js";
import { makeFindRelated } from "./src/tools/find_related.js";
import { classifyDiscovery } from "./src/guard.js";
import { detectTargets, freshnessSignal } from "./src/detect.js";
import { projectCacheDir, globalCacheDir, hfHome } from "./src/paths.js";
import { sembleSearch } from "./src/engine.js";

export default function (pi: ExtensionAPI) {
  if (process.env["PI_SEMBLE_DISABLE"]) return;
  for (const make of [makeCodeSearch, makeKbSearch, makeFindRelated]) pi.registerTool(make() as any);

  // Lazy warm: fire-and-forget cache build on session start, gated by git freshness. Never await, never block.
  pi.on("session_start", async () => {
    try {
      const t = detectTargets(process.cwd());
      const sentinel = path.join(projectCacheDir(t.repoRoot), ".warm-signal");
      const sig = freshnessSignal(t.repoRoot);
      let prev = ""; try { prev = fs.readFileSync(sentinel, "utf-8"); } catch { /* none */ }
      const stale = prev !== sig || sig === "nogit";
      if (t.isCode && stale) void sembleSearch("warm", { repo: t.repoRoot, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(), content: "code", topK: 1, maxSnippetLines: 0 });
      if (t.projectKb && stale) void sembleSearch("warm", { repo: t.projectKb, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(), content: "docs", topK: 1, maxSnippetLines: 0 });
      if (t.globalKb) void sembleSearch("warm", { repo: t.globalKb, cacheDir: globalCacheDir(), hfHome: hfHome(), content: "docs", topK: 1, maxSnippetLines: 0 });
      try { fs.mkdirSync(projectCacheDir(t.repoRoot), { recursive: true }); fs.writeFileSync(sentinel, sig, "utf-8"); fs.writeFileSync(path.join(projectCacheDir(t.repoRoot), ".gitignore"), "*\n", "utf-8"); } catch { /* ignore */ }
    } catch { /* fail-open */ }
  });

  // One-shot: teach the tools when the agent does manual code discovery.
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    try {
      const t = detectTargets(process.cwd());
      if (!t.isCode) return;
      const sentinel = path.join(projectCacheDir(t.repoRoot), ".guard-shot");
      if (fs.existsSync(sentinel)) return;
      const { hit, hint } = classifyDiscovery(event.toolName, event.input);
      if (!hit) return;
      try { fs.mkdirSync(projectCacheDir(t.repoRoot), { recursive: true }); fs.writeFileSync(sentinel, "1", "utf-8"); } catch { /* ignore */ }
      const shot = [
        `You used \`${hint}\` to explore the codebase, but this project has a semble index.`,
        "Prefer the dedicated tools — hybrid semantic+lexical, file:line out:",
        "  • `code_search({ query })` — find code by behavior or name",
        "  • `kb_search({ query })` — search the sourced doc library",
        "  • `find_related({ file_path, line })` — sibling implementations / callers / tests",
      ].join("\n");
      ctx.ui?.notify?.("Blocked manual discovery — teaching semble tools", "info");
      pi.sendUserMessage(shot, { deliverAs: "followUp" });
      return { block: true, reason: shot };
    } catch { return; }
  });
}
```

- [ ] **Step 5: Verify pass** — `npx vitest run test/guard.test.ts` → 1 passed.
- [ ] **Step 6: Sanity-load the extension** — `cd ~/.pi/agent/extensions/pi-semble && npx tsc --noEmit` → no type errors.
- [ ] **Step 7: Commit**

```bash
git add agent/extensions/pi-semble/src/guard.ts agent/extensions/pi-semble/index.ts agent/extensions/pi-semble/test/guard.test.ts
git commit -m "feat(semble): discovery guard + extension wiring + lazy warm"
```

---

## Task 7: End-to-end smoke (uvx-gated)

**Files:**
- Test: `agent/extensions/pi-semble/test/e2e.int.test.ts`

- [ ] **Step 1: Write the gated e2e** — builds a temp repo + kb, runs `code_search` and `kb_search` `execute` against a stubbed cwd.

```ts
import { test, expect, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { makeCodeSearch } from "../src/tools/code_search.js";
import { makeKbSearch } from "../src/tools/kb_search.js";

function hasUvx(): boolean { try { execSync("uvx --version", { stdio: "ignore" }); return true; } catch { return false; } }
const maybe = hasUvx() ? test : test.skip;

maybe("code_search and kb_search return results end to end", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "semble-e2e-"));
  fs.writeFileSync(path.join(repo, "package.json"), "{}");
  fs.writeFileSync(path.join(repo, "retry.ts"), "export function exponentialBackoff(n:number){ return 2**n; }\n");
  const kb = path.join(repo, "kb"); fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, "doc.md"), `---\nid: d1\nauthority: reference\nsources:\n  - url: https://x\n---\n# Backoff\nexponential backoff with jitter\n`);
  const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
  try {
    const cs = await makeCodeSearch().execute("i", { query: "exponential backoff", top_k: 3 });
    expect(cs.content[0].text).toMatch(/retry\.ts/);
    const ks = await makeKbSearch().execute("i", { query: "backoff jitter", scope: "project", top_k: 3 });
    expect(ks.content[0].text).toMatch(/doc\.md/);
    expect(ks.content[0].text).toMatch(/reference/);
  } finally { spy.mockRestore(); fs.rmSync(repo, { recursive: true, force: true }); }
}, 180_000);
```

- [ ] **Step 2: Run** — `npx vitest run test/e2e.int.test.ts` → 1 passed (on the target machine).
- [ ] **Step 3: Run the whole suite** — `npx vitest run` → all green.
- [ ] **Step 4: Commit**

```bash
git add agent/extensions/pi-semble/test/e2e.int.test.ts
git commit -m "test(semble): end-to-end code_search + kb_search smoke"
```

---

## Task 8: Migrate `code-vocab` → atlas-only

**Files:**
- Modify: `agent/extensions/code-vocab-wire.ts`

- [ ] **Step 1: Remove the `vocab_find` tool registration** (the `pi.registerTool({ name: "vocab_find", … })` block). Keep `vocab_usages`.
- [ ] **Step 2: Remove the `pi.on("tool_call", …)` manual-discovery guard block** (now owned by `pi-semble`) and the `shotSentinel`/`SOURCE_EXT` code only it used. Keep `session_start` (atlas build) and `before_agent_start` (atlas injection) untouched.
- [ ] **Step 3: Update the injected `contract()` text** — drop the `vocab_find` bullet; keep the atlas-orientation lines and the `vocab_usages` bullet. New body:

```ts
function contract(_root: string): string {
  return [
    "## Codebase atlas + lookup (auto-attached — this IS a coding project).",
    "Atlas below = PageRank map of THIS repo. Read it first to orient and map a concept to real symbol names.",
    "Search: use `code_search` (semantic) and `find_related`. Exhaustive call-sites: `vocab_usages`.",
  ].join("\n");
}
```

- [ ] **Step 4: Type-check + sanity** — `cd ~/.pi/agent/extensions && npx tsc --noEmit code-vocab-wire.ts` (or the workspace check) → no errors; grep confirms no remaining `vocab_find` registration.

Run: `grep -n "vocab_find" agent/extensions/code-vocab-wire.ts` → only references inside `vocab_usages` wiring (the python script path), none registering a `vocab_find` tool.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/code-vocab-wire.ts
git commit -m "refactor(code-vocab): atlas-only — drop vocab_find + guard (moved to pi-semble), keep vocab_usages"
```

---

## Task 9: Retire `pi-research-library` SQLite search; keep curation

> **SUPERSEDED BY DECISION (during execution): pi-research-library is REMOVED entirely.** Rationale: after search moved to pi-semble, its only non-redundant function was authoring sourced docs — and it dragged a now-search-dead SQLite stack. The whole extension is **archived out of the load path** (`agent/_archived-extensions/pi-research-library`); the 82 `kb/` markdown docs stay and remain searchable via pi-semble. Authoring is replaced by pi-semble's new **`kb_ingest`** (file-only: writes markdown+frontmatter, sources required, secret-scanned, no SQLite). Two tracked extensions that reached into pi-research-library were decoupled: `memory.ts` (typebox → bare import) and `capability-browser.ts` (`/docs` browser now reads kb/ frontmatter files instead of the removed KB db). Lost (accepted): `kb_open/cite/update/remove/collections`, `/kb-reindex`, `/kb-consolidate`.

**Files:**
- Modify: `agent/extensions/pi-research-library/index.ts`
- Delete: `src/db.ts`, `src/schema.ts`, `src/indexer.ts`, `src/search.ts`, `src/chunker.ts`, `src/registry.ts`, `src/tools/kb_search.ts` and their tests
- Modify: `package.json` (drop `better-sqlite3`)

- [ ] **Step 1: Stop registering `kb_search` and remove the `session_start` reindex.** In `index.ts`:
  - Remove `makeKbSearch` from the import list and from the `for (const make of [...])` array.
  - Delete the `pi.on("session_start", … reindexAll(ctx) …)` block.
  - Keep `kb_write/import/open/cite/collections/update/remove`, `registerCommands`, and the `before_agent_start` policy injection.

```ts
// new tool array (kb_search removed; search now lives in pi-semble):
for (const make of [makeKbOpen, makeKbCite, makeKbCollections, makeKbImport, makeKbWrite, makeKbUpdate, makeKbRemove])
  pi.registerTool(make(ctx) as any);
```

- [ ] **Step 2: Delete the SQLite modules + tests**

```bash
cd ~/.pi/agent/extensions/pi-research-library
git rm src/db.ts src/schema.ts src/indexer.ts src/search.ts src/chunker.ts src/registry.ts src/tools/kb_search.ts
git rm test/db.test.ts test/indexer.test.ts test/search.test.ts test/chunker.test.ts test/registry.test.ts test/kb_search.test.ts
```

- [ ] **Step 3: Excise dead references.** `kb-context.ts`/`commands.ts` reference `reindexAll`/`openDb`/`search` — remove `reindexAll` and any `kb_search`/indexer calls. Replace `/kb-reindex` command body with a no-op notice (`"Indexing is now handled by semble (pi-semble) automatically."`) or delete the command. Run `npx tsc --noEmit` and fix every unresolved import until clean.

- [ ] **Step 4: Drop the dependency** — remove `better-sqlite3` (+ `@types/better-sqlite3`, `allowScripts`) from `package.json`; `npm install` to prune.

- [ ] **Step 5: Verify** — `npx vitest run` in `pi-research-library` → remaining curation tests pass; `npx tsc --noEmit` → clean. Delete the now-orphan `kb/index.db*` files.

```bash
rm -f ~/.pi/kb/index.db ~/.pi/kb/index.db-shm ~/.pi/kb/index.db-wal ~/.pi/agent/extensions/pi-research-library/index.db* 2>/dev/null || true
```

- [ ] **Step 6: Commit**

```bash
git add -A agent/extensions/pi-research-library
git commit -m "refactor(kb): retire SQLite FTS5 search — kb_search now served by pi-semble; keep curation tools"
```

---

## Task 10: Cutover validation + docs

**Files:**
- Create: `agent/extensions/pi-semble/README.md`
- Modify: root `.gitignore` (ensure `**/.pi/semble/` ignored) and `agent/extensions/pi-semble/.gitignore` (`node_modules`)

- [ ] **Step 1: Confirm the OKF-search-upgrade plan is obsolete.** Add a one-line note at the top of `docs/superpowers/plans/2026-06-19-okf-search-upgrade.md`: `> SUPERSEDED by 2026-06-20-semble-search-integration.md — FTS5 search retired in favor of semble.` (Do not implement that plan.)
- [ ] **Step 2: Write `pi-semble/README.md`** — what it is, the three tools, the two cache scopes (`.pi/semble`, `~/.pi/cache/semble-global`), the model in `~/.pi/cache/hf`, `PI_SEMBLE_DISABLE=1`, and that first session downloads ~64 MB.
- [ ] **Step 3: `.gitignore`** — ensure `**/.pi/semble/` and `agent/extensions/pi-semble/node_modules/` are ignored; the per-dir `.gitignore` (`*`) written at warm time also covers project caches.
- [ ] **Step 4: Manual end-to-end in a real pi session** (checklist, not automated): open this repo in pi, confirm `code_search`/`kb_search`/`find_related` appear and return results, the guard fires once on a manual `grep`, the atlas still injects, and `kb_write` still works. Note any gaps.
- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-semble/README.md .gitignore docs/superpowers/plans/2026-06-19-okf-search-upgrade.md
git commit -m "docs(semble): README + cutover notes; mark OKF FTS5 plan superseded"
```

---

## Deferred — Phase 8: warm-MCP transport (optimization, not in scope for v1)

Only after v1 is in daily use and the ~1.4 s/call startup proves annoying. Swap `engine.ts` internals (keep `sembleSearch`/`sembleFindRelated` signatures) to talk to a lazily-spawned, warm `uvx --from "semble[mcp]" semble <path> --content all` stdio MCP server held per cache-scope in module state, via a small JSON-RPC-over-stdio client (initialize → `tools/call` `search`/`find_related`). Add teardown on `process.on("exit"/"SIGINT"/"SIGTERM")`. **Note the per-server `--content` fixity:** each scope's server runs `--content all`, and `code_search` vs `kb_search` separate by the `repo`/path argument + result path-filtering, since content can no longer be chosen per call. No tool or test changes — same engine interface.

---

## Self-Review

**Spec coverage:** (1) ingest/search doc tools → `kb_search` + kept `kb_write`/curation (Tasks 5, 9); (2) auto-detect + build index locally → `detect.ts` + session_start warm (Tasks 3, 6); (3) project + global doc index → two cache scopes + `scope` param (Tasks 3, 5); (4) code search replacing `vocab_find` → `code_search` + Task 8; (5) `.pi` artifact location → `projectCacheDir`/`globalCacheDir`/`hfHome` (Task 3); (6) provenance kept → Task 4; (7) atlas + `vocab_usages` kept → Task 8; (8) fuzzy = semble-native, no extra code → reflected in decisions, no task. All covered.

**Placeholder scan:** every code step has full code; commands have expected output; no "TODO"/"handle errors"/"similar to". Clean.

**Type consistency:** `SembleHit`/`SembleOpts` (Task 1) consumed unchanged by Tasks 2/4/5; `KbHit` (Task 4) used in Task 5; `detectTargets`→`Targets` fields (`repoRoot`/`isCode`/`projectKb`/`globalKb`) used consistently in Tasks 5/6; cache-path fn names (`projectCacheDir`/`globalCacheDir`/`hfHome`) identical across Tasks 3/5/6.

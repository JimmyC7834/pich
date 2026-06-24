# Local Harness — Firewall (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local-model "context firewall" tools so the cloud brain (DeepSeek) never ingests raw bulk — a code-aware `summarize`, a new `compress` (noisy tool output → distilled), and a new ripgrep-backed `code_search`.

**Architecture:** Three single-shot tools the orchestrator calls like functions. Each runs a local Ollama model with a rigid, role-specific prompt held in an `agent/agents/*.md` file (single source of truth). `summarize` routes code→qwen2.5-coder:14b and prose→qwen2.5-coder:3b. `compress` runs on the 3b. `code_search` runs ripgrep, then uses the 3b to pick + explain the best hits. No vector index.

**Tech Stack:** TypeScript (NodeNext ESM), pi extension API (`@earendil-works/pi-coding-agent`), `typebox` for tool param schemas, `vitest` for tests, Ollama HTTP API, ripgrep (`rg`).

**Scope:** Phase 1 only (the firewall). Phase 2 (local sub-loops) and Phase 3 (router) are separate plans.

---

## Prerequisites

- [ ] **P0: Pull the fast model and confirm Ollama is reachable**

Run:
```bash
ollama pull qwen2.5-coder:3b
ollama list | grep qwen2.5-coder
curl -s http://localhost:11434/api/tags >/dev/null && echo "ollama up"
```
Expected: both `qwen2.5-coder:14b` and `qwen2.5-coder:3b` listed; `ollama up` printed.
(`14b` is already installed per the spec; this adds the 3b.)

- [ ] **P1: Confirm ripgrep is available**

Run: `rg --version`
Expected: prints a ripgrep version. If missing, install it (`winget install BurntSushi.ripgrep.MSVC` on Windows) before Task 3.

---

## File Structure

**Modified (existing flat extension):**
- `agent/extensions/summarize.ts` — add code/prose model routing.
- `agent/agents/summarizer.md` — repoint model phi3.5 → qwen2.5-coder:14b; tighten prompt for code.

**Created (agent prompt files — single source of truth for each role):**
- `agent/agents/summarizer-fast.md` — prose summarizer on the 3b.
- `agent/agents/compressor.md` — tool-output compressor prompt (3b).
- `agent/agents/code-search.md` — ranking/explanation prompt for `code_search` (3b).

**Created (new packaged extension — `compress`):**
- `agent/extensions/pi-compress/package.json`
- `agent/extensions/pi-compress/tsconfig.json`
- `agent/extensions/pi-compress/index.ts` — registers the `compress` tool.
- `agent/extensions/pi-compress/src/agent.ts` — load `{model,system}` from an agent .md.
- `agent/extensions/pi-compress/src/ollama.ts` — Ollama chat client with keep_alive/num_ctx.
- `agent/extensions/pi-compress/src/chunk.ts` — text chunking (ported from summarize).
- `agent/extensions/pi-compress/test/agent.test.ts`
- `agent/extensions/pi-compress/test/chunk.test.ts`
- `agent/extensions/pi-compress/test/execute.test.ts`
- `agent/extensions/pi-compress/scripts/smoke.mjs` — manual integration smoke (real Ollama).

**Created (new packaged extension — `code_search`):**
- `agent/extensions/pi-code-search/package.json`
- `agent/extensions/pi-code-search/tsconfig.json`
- `agent/extensions/pi-code-search/index.ts` — registers the `code_search` tool.
- `agent/extensions/pi-code-search/src/ripgrep.ts` — build `rg --json` args + parse output.
- `agent/extensions/pi-code-search/src/agent.ts` — load `{model,system}` (shares shape with compress).
- `agent/extensions/pi-code-search/src/ollama.ts` — Ollama chat client.
- `agent/extensions/pi-code-search/src/rank.ts` — build the ranking prompt from hits.
- `agent/extensions/pi-code-search/test/ripgrep.test.ts`
- `agent/extensions/pi-code-search/test/rank.test.ts`
- `agent/extensions/pi-code-search/test/execute.test.ts`
- `agent/extensions/pi-code-search/scripts/smoke.mjs`

**Modified (skills/docs):**
- `skills/orchestrator/SKILL.md` — mention `compress` and `code_search` in the firewall rules.

**Test strategy:** new packaged extensions get full vitest TDD with mocked `fetch` (Ollama) and mocked `child_process` (ripgrep) — deterministic, no model needed. The flat `summarize.ts` change has no unit runner in-repo (matching existing convention) and is verified by the Task 6 integration checklist against live Ollama.

---

## Task 1: Code/prose model routing in `summarize`

**Files:**
- Modify: `agent/extensions/summarize.ts`
- Modify: `agent/agents/summarizer.md`
- Create: `agent/agents/summarizer-fast.md`

- [ ] **Step 1: Repoint the code summarizer agent to the 14b**

Replace the frontmatter + body of `agent/agents/summarizer.md` with:
```markdown
---
name: summarizer
description: Summarizes code/source files using Qwen2.5-Coder 14B via Ollama — text in → text out
tools: false
model: ollama/qwen2.5-coder:14b
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---

You summarize source code for another engineer who will NOT see the file. Return ONLY:
- **Purpose:** one line.
- **Exports / public API:** each name + a 5-10 word description.
- **Key types:** notable types/interfaces and their shape in one line each.
- **Core logic:** 2-4 bullets on the important control flow or algorithm.
Use exact identifier names. No preamble, no questions, no fluff. If the input is not code, summarize it in 3 sentences instead.
```

- [ ] **Step 2: Create the prose/fast summarizer agent (3b)**

Create `agent/agents/summarizer-fast.md`:
```markdown
---
name: summarizer-fast
description: Fast prose summarizer using Qwen2.5-Coder 3B via Ollama — text in → text out
tools: false
model: ollama/qwen2.5-coder:3b
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---

You are a concise summarizer. Given text, return a 2-3 sentence summary capturing the key points. Do not ask questions, do not use tools, no preamble. Just the summary.
```

- [ ] **Step 3: Add profile routing to `summarize.ts`**

In `agent/extensions/summarize.ts`, replace the `AGENT_FILE` constant and `loadSummarizer()` function with the following (keeps the existing frontmatter parser, adds a second profile + extension routing):
```ts
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent", "agents");
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".rb", ".php", ".swift", ".kt",
  ".scala", ".sh", ".bash", ".sql", ".json", ".yaml", ".yml", ".toml",
]);

/** Pick which summarizer profile to use for a target. URLs and unknown files → prose. */
export function pickProfile(target: string): "code" | "prose" {
  if (/^https?:\/\//i.test(target)) return "prose";
  const dot = target.lastIndexOf(".");
  if (dot < 0) return "prose";
  return CODE_EXTS.has(target.slice(dot).toLowerCase()) ? "code" : "prose";
}

/** Read an agent .md (model + system prompt). Falls back to phi3.5 + a default prompt. */
function loadProfile(file: string): { model: string; system: string } {
  let model = DEFAULT_MODEL;
  let system = DEFAULT_PROMPT;
  try {
    const raw = fs.readFileSync(path.join(AGENT_DIR, file), "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (m) {
      const mm = m[1]!.match(/^model:\s*(.+)$/m);
      if (mm) model = mm[1]!.trim();
      const body = m[2]!.trim();
      if (body) system = body;
    }
  } catch {
    /* fall back to defaults */
  }
  return { model: model.replace(/^ollama\//, ""), system };
}

/** Choose the summarizer profile for a target. */
function loadSummarizer(target: string): { model: string; system: string } {
  return loadProfile(pickProfile(target) === "code" ? "summarizer.md" : "summarizer-fast.md");
}
```

- [ ] **Step 4: Pass the target into `loadSummarizer` at the call site**

In the `execute` method of the `summarize` tool, change:
```ts
        const { model, system } = loadSummarizer();
```
to:
```ts
        const { model, system } = loadSummarizer(target);
```
(`target` is already defined two lines above.)

- [ ] **Step 5: Set the 14b keep-alive + context cap on the Ollama call**

The spec wants the heavy 14b to use a short keep-alive (so it unloads and frees VRAM) and a
capped context. In `agent/extensions/summarize.ts`, find the `body: JSON.stringify({` inside
`ollamaChat` and change it from:
```ts
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
```
to:
```ts
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: "5m",
        options: { num_ctx: 32768 },
        messages: [
```

- [ ] **Step 6: Verify the edits are present (flat file — no in-repo unit runner)**

Run: `grep -n "export function pickProfile\|loadSummarizer(target)\|keep_alive" agent/extensions/summarize.ts`
Expected: `pickProfile` is defined, `loadSummarizer(target)` is the call site, and `keep_alive` is set. (This flat extension has no vitest harness by repo convention; behavior is confirmed by the Task 14 integration check against live Ollama.)

- [ ] **Step 7: Commit**

```bash
git add agent/extensions/summarize.ts agent/agents/summarizer.md agent/agents/summarizer-fast.md
git commit -m "feat(summarize): route code->qwen14b, prose->qwen3b; cap 14b ctx + keep-alive"
```

---

## Task 2: Scaffold the `compress` extension package

**Files:**
- Create: `agent/extensions/pi-compress/package.json`
- Create: `agent/extensions/pi-compress/tsconfig.json`

- [ ] **Step 1: Create `package.json`**

Create `agent/extensions/pi-compress/package.json`:
```json
{
  "name": "pi-compress",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "vitest run", "check": "tsc --noEmit" },
  "dependencies": { "typebox": "^1.2.9" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.2",
    "@types/node": "^20.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Create `agent/extensions/pi-compress/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "noEmit": true, "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts"],
  "exclude": ["test/**/*.ts", "node_modules"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd agent/extensions/pi-compress && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 4: Commit**

```bash
git add agent/extensions/pi-compress/package.json agent/extensions/pi-compress/tsconfig.json
git commit -m "chore(compress): scaffold pi-compress extension package"
```

---

## Task 3: `compress` — chunking helper (TDD)

**Files:**
- Create: `agent/extensions/pi-compress/src/chunk.ts`
- Test: `agent/extensions/pi-compress/test/chunk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/extensions/pi-compress/test/chunk.test.ts`:
```ts
import { test, expect } from "vitest";
import { chunk } from "../src/chunk.js";

test("returns one chunk when text is under size", () => {
  expect(chunk("hello", 100)).toEqual(["hello"]);
});

test("splits long text into multiple chunks under size", () => {
  const text = "x".repeat(250);
  const parts = chunk(text, 100);
  expect(parts.length).toBe(3);
  expect(parts.join("")).toBe(text);
});

test("prefers a newline boundary past the halfway point", () => {
  const text = "a".repeat(60) + "\n" + "b".repeat(60);
  const parts = chunk(text, 100);
  expect(parts[0]).toBe("a".repeat(60)); // split at the newline, not at 100
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-compress && npx vitest run test/chunk.test.ts`
Expected: FAIL — `Cannot find module '../src/chunk.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `agent/extensions/pi-compress/src/chunk.ts`:
```ts
/** Split text into ~size chunks, preferring newline boundaries past the halfway point. */
export function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + size * 0.5) end = nl;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-compress && npx vitest run test/chunk.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-compress/src/chunk.ts agent/extensions/pi-compress/test/chunk.test.ts
git commit -m "feat(compress): chunking helper with newline-aware splitting"
```

---

## Task 4: `compress` — agent loader (TDD)

**Files:**
- Create: `agent/extensions/pi-compress/src/agent.ts`
- Test: `agent/extensions/pi-compress/test/agent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/extensions/pi-compress/test/agent.test.ts`:
```ts
import { test, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "../src/agent.js";

const dirs: string[] = [];
function tmp(contents: string): string {
  const d = mkdtempSync(join(tmpdir(), "agent-"));
  dirs.push(d);
  writeFileSync(join(d, "a.md"), contents);
  return join(d, "a.md");
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("parses model (stripping ollama/ prefix) and system body", () => {
  const f = tmp("---\nmodel: ollama/qwen2.5-coder:3b\n---\nBe terse.");
  expect(loadAgent(f, "fallback", "def")).toEqual({ model: "qwen2.5-coder:3b", system: "Be terse." });
});

test("falls back when file is missing", () => {
  expect(loadAgent("/no/such/file.md", "fb-model", "fb-prompt"))
    .toEqual({ model: "fb-model", system: "fb-prompt" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-compress && npx vitest run test/agent.test.ts`
Expected: FAIL — `Cannot find module '../src/agent.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `agent/extensions/pi-compress/src/agent.ts`:
```ts
import { readFileSync } from "node:fs";

/** Read an agent .md file, returning its model (without ollama/ prefix) and system body. */
export function loadAgent(file: string, fallbackModel: string, fallbackPrompt: string): { model: string; system: string } {
  let model = fallbackModel;
  let system = fallbackPrompt;
  try {
    const raw = readFileSync(file, "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (m) {
      const mm = m[1]!.match(/^model:\s*(.+)$/m);
      if (mm) model = mm[1]!.trim();
      const body = m[2]!.trim();
      if (body) system = body;
    }
  } catch {
    /* fall back */
  }
  return { model: model.replace(/^ollama\//, ""), system };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-compress && npx vitest run test/agent.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-compress/src/agent.ts agent/extensions/pi-compress/test/agent.test.ts
git commit -m "feat(compress): agent .md loader with fallback"
```

---

## Task 5: `compress` — Ollama client

**Files:**
- Create: `agent/extensions/pi-compress/src/ollama.ts`

- [ ] **Step 1: Write the Ollama client**

Create `agent/extensions/pi-compress/src/ollama.ts`. It pins low VRAM use via `keep_alive` and a capped `num_ctx`, and accepts an injectable `fetchFn` so tests can mock it:
```ts
type FetchFn = typeof fetch;

export interface OllamaOpts {
  host?: string;
  keepAlive?: string;   // e.g. "-1" pinned, "5m"
  numCtx?: number;
  timeoutMs?: number;
  fetchFn?: FetchFn;
}

/** One non-streaming chat turn against Ollama. */
export async function ollamaChat(
  model: string,
  system: string,
  user: string,
  opts: OllamaOpts = {},
  signal?: AbortSignal,
): Promise<string> {
  const host = opts.host ?? process.env["OLLAMA_HOST"] ?? "http://localhost:11434";
  const doFetch = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  signal?.addEventListener("abort", () => ctrl.abort());
  try {
    const res = await doFetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: opts.keepAlive ?? "-1",
        options: { num_ctx: opts.numCtx ?? 8192 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const j: any = await res.json();
    return String(j?.message?.content ?? "").trim();
  } finally {
    clearTimeout(t);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/extensions/pi-compress/src/ollama.ts
git commit -m "feat(compress): ollama chat client with keep_alive + num_ctx"
```

---

## Task 6: `compress` — the prompt file + tool registration (TDD execute)

**Files:**
- Create: `agent/agents/compressor.md`
- Create: `agent/extensions/pi-compress/index.ts`
- Test: `agent/extensions/pi-compress/test/execute.test.ts`

- [ ] **Step 1: Create the compressor prompt (single source of truth)**

Create `agent/agents/compressor.md`:
```markdown
---
name: compressor
description: Compresses noisy tool output (logs, stack traces, dumps) to the essentials via Qwen2.5-Coder 3B
tools: false
model: ollama/qwen2.5-coder:3b
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---

You compress noisy command/tool output for an engineer who will NOT see the original. Return ONLY:
- **Verdict:** one line — pass/fail/what happened.
- **Signal:** the few lines that actually matter (errors, failing assertions, the first real stack frame, the offending file:line). Quote them verbatim.
Drop progress bars, timestamps, passing noise, and repetition. Never narrate. If a FOCUS is given, keep only output relevant to it. Be ruthless: aim for under 200 words.
```

- [ ] **Step 2: Write the failing execute test**

Create `agent/extensions/pi-compress/test/execute.test.ts`:
```ts
import { test, expect, vi } from "vitest";
import makeExtension from "../index.js";

function fakeFetch(reply: string) {
  return vi.fn(async () => new Response(JSON.stringify({ message: { content: reply } }), { status: 200 }));
}

function register() {
  const tools: any[] = [];
  makeExtension({ registerTool: (t: any) => tools.push(t) } as any);
  return tools.find((t) => t.name === "compress");
}

test("registers a compress tool", () => {
  expect(register()).toBeTruthy();
});

test("returns the model's compressed text", async () => {
  const tool = register();
  const ff = fakeFetch("Verdict: 2 tests failed.\nSignal: AssertionError at foo.test.ts:10");
  const res = await tool.execute("id", { text: "x".repeat(50), fetchFn: ff }, undefined);
  expect(res.content[0].text).toContain("AssertionError at foo.test.ts:10");
  expect(ff).toHaveBeenCalledOnce();
});

test("handles empty input without calling the model", async () => {
  const tool = register();
  const ff = fakeFetch("should not be used");
  const res = await tool.execute("id", { text: "   ", fetchFn: ff }, undefined);
  expect(res.content[0].text).toMatch(/nothing to compress/i);
  expect(ff).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd agent/extensions/pi-compress && npx vitest run test/execute.test.ts`
Expected: FAIL — `Cannot find module '../index.js'`.

- [ ] **Step 4: Write the extension**

Create `agent/extensions/pi-compress/index.ts`:
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { loadAgent } from "./src/agent.js";
import { chunk } from "./src/chunk.js";
import { ollamaChat, type OllamaOpts } from "./src/ollama.js";

const AGENT_FILE = path.join(os.homedir(), ".pi", "agent", "agents", "compressor.md");
const FALLBACK_MODEL = "qwen2.5-coder:3b";
const FALLBACK_PROMPT =
  "Compress this output to a one-line verdict plus only the lines that matter. No narration.";
const CHUNK_CHARS = 8000;
const MAX_CHUNKS = 12;

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function (pi: ExtensionAPI) {
  if (process.env["COMPRESS_DISABLE"]) return;

  pi.registerTool({
    name: "compress",
    label: "Compress",
    description:
      "Distill noisy tool output (test/build logs, stack traces, grep/ls dumps) to a one-line verdict plus the lines that matter, using a local model. Wrap high-volume command output in this BEFORE reading it, to keep it out of your context.",
    promptSnippet: "compress: distill noisy tool output to the essentials (local model)",
    parameters: Type.Object({
      text: Type.String({ description: "The raw tool output to compress." }),
      focus: Type.Optional(Type.String({ description: "Optional: only keep output relevant to this." })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      try {
        const text = String(p?.text ?? "").trim();
        if (!text) return out("(nothing to compress: input was empty)");
        const { model, system } = loadAgent(AGENT_FILE, FALLBACK_MODEL, FALLBACK_PROMPT);
        const focus = String(p?.focus ?? "").trim();
        const sys = focus ? `${system}\n\nFOCUS: ${focus}` : system;
        const opts: OllamaOpts = { keepAlive: "-1", numCtx: 8192, fetchFn: p?.fetchFn };

        if (text.length <= CHUNK_CHARS) {
          return out((await ollamaChat(model, sys, text, opts, signal)) || "(compressor returned nothing)");
        }
        // Map-reduce for very large output.
        const parts = chunk(text, CHUNK_CHARS).slice(0, MAX_CHUNKS);
        const pieces: string[] = [];
        for (const part of parts) pieces.push(await ollamaChat(model, sys, part, opts, signal));
        const merged = pieces.join("\n\n");
        const final = merged.length <= CHUNK_CHARS ? await ollamaChat(model, sys, merged, opts, signal) : merged;
        return out(final || "(compressor returned nothing)");
      } catch (e: any) {
        return out(`compress failed: ${e?.message ?? String(e)}`);
      }
    },
  } as any);
}
```

Note: `fetchFn` is threaded through the params purely so tests can inject a fake; in production the param is absent and `ollamaChat` uses the real `fetch`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd agent/extensions/pi-compress && npx vitest run`
Expected: PASS — all compress tests (chunk + agent + execute).

- [ ] **Step 6: Type-check**

Run: `cd agent/extensions/pi-compress && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add agent/agents/compressor.md agent/extensions/pi-compress/index.ts agent/extensions/pi-compress/test/execute.test.ts
git commit -m "feat(compress): register compress tool with compressor prompt"
```

---

## Task 7: `compress` — manual integration smoke (real Ollama)

**Files:**
- Create: `agent/extensions/pi-compress/scripts/smoke.mjs`

- [ ] **Step 1: Write the smoke script**

Create `agent/extensions/pi-compress/scripts/smoke.mjs`:
```js
// Manual smoke test — requires Ollama running with qwen2.5-coder:3b.
// Run: node agent/extensions/pi-compress/scripts/smoke.mjs
import makeExtension from "../index.ts";

const tools = [];
makeExtension({ registerTool: (t) => tools.push(t) });
const compress = tools.find((t) => t.name === "compress");

const noisy = [
  "[12:00:01] downloading...",
  "[12:00:02] 10%......50%......100%",
  "PASS src/a.test.ts",
  "PASS src/b.test.ts",
  "FAIL src/c.test.ts",
  "  ● adds two numbers",
  "    expected 4 but received 5",
  "    at Object.<anonymous> (src/c.test.ts:14:22)",
].join("\n");

const res = await compress.execute("smoke", { text: noisy }, undefined);
console.log("--- compressed ---");
console.log(res.content[0].text);
```

- [ ] **Step 2: Run the smoke test**

Run: `node agent/extensions/pi-compress/scripts/smoke.mjs`
Expected: output names the FAIL in `src/c.test.ts:14` and the `expected 4 but received 5` assertion, and drops the download/progress noise. If the model rambles or includes the passing lines, tighten `agent/agents/compressor.md` and re-run (this is the prompt-engineering loop).

- [ ] **Step 3: Commit**

```bash
git add agent/extensions/pi-compress/scripts/smoke.mjs
git commit -m "test(compress): manual integration smoke script"
```

---

## Task 8: Scaffold the `code_search` extension package

**Files:**
- Create: `agent/extensions/pi-code-search/package.json`
- Create: `agent/extensions/pi-code-search/tsconfig.json`

- [ ] **Step 1: Create `package.json`**

Create `agent/extensions/pi-code-search/package.json`:
```json
{
  "name": "pi-code-search",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "vitest run", "check": "tsc --noEmit" },
  "dependencies": { "typebox": "^1.2.9" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.2",
    "@types/node": "^20.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Create `agent/extensions/pi-code-search/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "noEmit": true, "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts"],
  "exclude": ["test/**/*.ts", "node_modules"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd agent/extensions/pi-code-search && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 4: Copy the shared agent loader + Ollama client**

These two files are identical to the compress versions (small, self-contained; duplicating avoids a cross-package dependency). Create `agent/extensions/pi-code-search/src/agent.ts` with the exact contents from Task 4 Step 3, and `agent/extensions/pi-code-search/src/ollama.ts` with the exact contents from Task 5 Step 1.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-code-search/package.json agent/extensions/pi-code-search/tsconfig.json agent/extensions/pi-code-search/src/agent.ts agent/extensions/pi-code-search/src/ollama.ts
git commit -m "chore(code-search): scaffold pi-code-search package + shared helpers"
```

---

## Task 9: `code_search` — ripgrep args + JSON parse (TDD)

**Files:**
- Create: `agent/extensions/pi-code-search/src/ripgrep.ts`
- Test: `agent/extensions/pi-code-search/test/ripgrep.test.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/extensions/pi-code-search/test/ripgrep.test.ts`:
```ts
import { test, expect } from "vitest";
import { buildRgArgs, parseRgJson, type Hit } from "../src/ripgrep.js";

test("builds case-insensitive json args with a path scope", () => {
  expect(buildRgArgs("loadAgent", "agent/extensions")).toEqual([
    "--json", "-i", "--max-count", "50", "loadAgent", "agent/extensions",
  ]);
});

test("defaults the path to current dir", () => {
  expect(buildRgArgs("foo")).toEqual(["--json", "-i", "--max-count", "50", "foo", "."]);
});

test("parses match lines into file/line/text hits", () => {
  const stdout = [
    JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }),
    JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, line_number: 12, lines: { text: "const foo = 1\n" } } }),
    JSON.stringify({ type: "summary", data: {} }),
  ].join("\n");
  const hits: Hit[] = parseRgJson(stdout);
  expect(hits).toEqual([{ file: "a.ts", line: 12, text: "const foo = 1" }]);
});

test("ignores malformed lines", () => {
  expect(parseRgJson("not json\n{bad}")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-code-search && npx vitest run test/ripgrep.test.ts`
Expected: FAIL — `Cannot find module '../src/ripgrep.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `agent/extensions/pi-code-search/src/ripgrep.ts`:
```ts
export interface Hit { file: string; line: number; text: string; }

/** Build `rg --json` args for a case-insensitive, capped search. */
export function buildRgArgs(query: string, path = "."): string[] {
  return ["--json", "-i", "--max-count", "50", query, path];
}

/** Parse `rg --json` stdout into hits, ignoring non-match and malformed lines. */
export function parseRgJson(stdout: string): Hit[] {
  const hits: Hit[] = [];
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (ev?.type !== "match") continue;
      hits.push({
        file: String(ev.data.path.text),
        line: Number(ev.data.line_number),
        text: String(ev.data.lines.text ?? "").replace(/\n$/, ""),
      });
    } catch {
      /* ignore malformed line */
    }
  }
  return hits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-code-search && npx vitest run test/ripgrep.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-code-search/src/ripgrep.ts agent/extensions/pi-code-search/test/ripgrep.test.ts
git commit -m "feat(code-search): ripgrep arg builder + json parser"
```

---

## Task 10: `code_search` — ranking prompt builder (TDD)

**Files:**
- Create: `agent/extensions/pi-code-search/src/rank.ts`
- Test: `agent/extensions/pi-code-search/test/rank.test.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/extensions/pi-code-search/test/rank.test.ts`:
```ts
import { test, expect } from "vitest";
import { buildRankUser } from "../src/rank.js";
import type { Hit } from "../src/ripgrep.js";

const hits: Hit[] = [
  { file: "a.ts", line: 10, text: "function loadAgent() {" },
  { file: "b.ts", line: 22, text: "loadAgent(file)" },
];

test("includes the query and every hit with an index, file:line and text", () => {
  const u = buildRankUser("where is loadAgent defined", hits);
  expect(u).toContain("where is loadAgent defined");
  expect(u).toContain("[1] a.ts:10 | function loadAgent() {");
  expect(u).toContain("[2] b.ts:22 | loadAgent(file)");
});

test("renders an empty-hit notice", () => {
  expect(buildRankUser("x", [])).toContain("No matches");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent/extensions/pi-code-search && npx vitest run test/rank.test.ts`
Expected: FAIL — `Cannot find module '../src/rank.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `agent/extensions/pi-code-search/src/rank.ts`:
```ts
import type { Hit } from "./ripgrep.js";

/** Build the user message asking the model to pick + explain the best hits. */
export function buildRankUser(query: string, hits: Hit[]): string {
  if (hits.length === 0) return `QUERY: ${query}\n\nNo matches were found by ripgrep.`;
  const lines = hits.map((h, i) => `[${i + 1}] ${h.file}:${h.line} | ${h.text.trim()}`);
  return `QUERY: ${query}\n\nCANDIDATES:\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent/extensions/pi-code-search && npx vitest run test/rank.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-code-search/src/rank.ts agent/extensions/pi-code-search/test/rank.test.ts
git commit -m "feat(code-search): ranking prompt builder"
```

---

## Task 11: `code_search` — prompt file + tool registration (TDD execute)

**Files:**
- Create: `agent/agents/code-search.md`
- Create: `agent/extensions/pi-code-search/index.ts`
- Test: `agent/extensions/pi-code-search/test/execute.test.ts`

- [ ] **Step 1: Create the code-search prompt**

Create `agent/agents/code-search.md`:
```markdown
---
name: code-search
description: Picks and explains the best ripgrep hits for a query via Qwen2.5-Coder 3B
tools: false
model: ollama/qwen2.5-coder:3b
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---

You are given a QUERY and a numbered list of ripgrep CANDIDATES (each `file:line | code`). Return the 3-5 candidates that best answer the query, most relevant first, as a plain list:

`file:line` — 8-15 words on why this matches.

Use ONLY the candidates provided; never invent paths or lines. If none are relevant, say "No relevant matches." No preamble, no code blocks, nothing else.
```

- [ ] **Step 2: Write the failing execute test**

Create `agent/extensions/pi-code-search/test/execute.test.ts`:
```ts
import { test, expect, vi } from "vitest";
import makeExtension from "../index.js";

function register(runRg: any) {
  const tools: any[] = [];
  makeExtension({ registerTool: (t: any) => tools.push(t) } as any);
  const tool = tools.find((t) => t.name === "code_search");
  tool.__setRunRg(runRg); // test seam
  return tool;
}

const fetchReply = (reply: string) =>
  vi.fn(async () => new Response(JSON.stringify({ message: { content: reply } }), { status: 200 }));

test("registers a code_search tool", () => {
  expect(register(async () => "")).toBeTruthy();
});

test("greps, ranks, and returns the model's picks", async () => {
  const rgOut = JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, line_number: 9, lines: { text: "export function loadAgent() {\n" } } });
  const tool = register(async () => rgOut);
  const ff = fetchReply("src/a.ts:9 — defines loadAgent, the function asked about");
  const res = await tool.execute("id", { query: "where is loadAgent defined", fetchFn: ff }, undefined);
  expect(res.content[0].text).toContain("src/a.ts:9");
  expect(ff).toHaveBeenCalledOnce();
});

test("reports no matches without calling the model", async () => {
  const tool = register(async () => "");
  const ff = fetchReply("unused");
  const res = await tool.execute("id", { query: "nope", fetchFn: ff }, undefined);
  expect(res.content[0].text).toMatch(/no matches/i);
  expect(ff).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd agent/extensions/pi-code-search && npx vitest run test/execute.test.ts`
Expected: FAIL — `Cannot find module '../index.js'`.

- [ ] **Step 4: Write the extension**

Create `agent/extensions/pi-code-search/index.ts`. The `runRg` function is exposed via a `__setRunRg` seam so tests inject a fake instead of spawning a real process:
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { loadAgent } from "./src/agent.js";
import { ollamaChat, type OllamaOpts } from "./src/ollama.js";
import { buildRgArgs, parseRgJson } from "./src/ripgrep.js";
import { buildRankUser } from "./src/rank.js";

const AGENT_FILE = path.join(os.homedir(), ".pi", "agent", "agents", "code-search.md");
const FALLBACK_MODEL = "qwen2.5-coder:3b";
const FALLBACK_PROMPT =
  "Given a QUERY and numbered CANDIDATES (file:line | code), return the 3-5 best as `file:line` — why. Use only the candidates.";

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** Run ripgrep and return raw stdout (empty string on no matches / rg exit 1). */
function defaultRunRg(query: string, scope: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("rg", buildRgArgs(query, scope), { signal });
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(stdout)); // rg exits 1 on no matches; stdout already captured
  });
}

export default function (pi: ExtensionAPI) {
  if (process.env["CODE_SEARCH_DISABLE"]) return;

  let runRg = defaultRunRg;

  pi.registerTool({
    name: "code_search",
    label: "Code Search",
    description:
      "Find where something is in the codebase WITHOUT reading files into your context. Runs ripgrep, then a local model returns the 3-5 best `file:line` matches with a one-line why. Use instead of reading files to locate code.",
    promptSnippet: "code_search: locate code by ripgrep + local ranking (file:line + why)",
    parameters: Type.Object({
      query: Type.String({ description: "What to find (identifier, phrase, or concept keywords)." }),
      path: Type.Optional(Type.String({ description: "Optional path/dir to scope the search. Default: repo root." })),
    }),
    // Test seam: lets unit tests inject a fake ripgrep runner.
    __setRunRg(fn: typeof defaultRunRg) { runRg = fn; },
    async execute(_id: string, p: any, signal?: AbortSignal) {
      try {
        const query = String(p?.query ?? "").trim();
        if (!query) return out("Provide a query to search for.");
        const scope = String(p?.path ?? ".").trim() || ".";
        const stdout = await runRg(query, scope, signal);
        const hits = parseRgJson(stdout).slice(0, 50);
        if (hits.length === 0) return out(`No matches for "${query}".`);
        const { model, system } = loadAgent(AGENT_FILE, FALLBACK_MODEL, FALLBACK_PROMPT);
        const opts: OllamaOpts = { keepAlive: "-1", numCtx: 8192, fetchFn: p?.fetchFn };
        const ranked = await ollamaChat(model, system, buildRankUser(query, hits), opts, signal);
        return out(ranked || hits.slice(0, 5).map((h) => `${h.file}:${h.line}`).join("\n"));
      } catch (e: any) {
        return out(`code_search failed: ${e?.message ?? String(e)}`);
      }
    },
  } as any);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd agent/extensions/pi-code-search && npx vitest run`
Expected: PASS — all code-search tests (ripgrep + rank + execute).

- [ ] **Step 6: Type-check**

Run: `cd agent/extensions/pi-code-search && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add agent/agents/code-search.md agent/extensions/pi-code-search/index.ts agent/extensions/pi-code-search/test/execute.test.ts
git commit -m "feat(code-search): register code_search tool (ripgrep + local rank)"
```

---

## Task 12: `code_search` — manual integration smoke (real Ollama + rg)

**Files:**
- Create: `agent/extensions/pi-code-search/scripts/smoke.mjs`

- [ ] **Step 1: Write the smoke script**

Create `agent/extensions/pi-code-search/scripts/smoke.mjs`:
```js
// Manual smoke test — requires Ollama (qwen2.5-coder:3b) and ripgrep on PATH.
// Run from repo root: node agent/extensions/pi-code-search/scripts/smoke.mjs
import makeExtension from "../index.ts";

const tools = [];
makeExtension({ registerTool: (t) => tools.push(t) });
const cs = tools.find((t) => t.name === "code_search");

const res = await cs.execute("smoke", { query: "registerTool", path: "agent/extensions" }, undefined);
console.log("--- code_search results ---");
console.log(res.content[0].text);
```

- [ ] **Step 2: Run the smoke test**

Run: `node agent/extensions/pi-code-search/scripts/smoke.mjs`
Expected: a short list of `file:line — why` lines pointing at real `registerTool` call sites (e.g. in `summarize.ts`, `memory.ts`). If output invents paths or rambles, tighten `agent/agents/code-search.md`.

- [ ] **Step 3: Commit**

```bash
git add agent/extensions/pi-code-search/scripts/smoke.mjs
git commit -m "test(code-search): manual integration smoke script"
```

---

## Task 13: Teach the orchestrator skill the new tools

**Files:**
- Modify: `skills/orchestrator/SKILL.md`

- [ ] **Step 1: Add the firewall tools to the Context Hygiene section**

In `skills/orchestrator/SKILL.md`, find the paragraph beginning "**CRITICAL RULE: NEVER read files or documents directly yourself.**" Immediately after that paragraph, insert:
```markdown
**Wrap noisy tool output in `compress`.** Before reading any large command output — test runs, build logs, stack traces, long `grep`/`ls` dumps — pass it through the `compress` tool and read the distilled result, not the raw output.

**Locate code with `code_search`, not by reading.** To find where something is defined or used, call `code_search` (ripgrep + local ranking) and get back `file:line` references. Only read the 1-2 lines you need right before an edit.
```

- [ ] **Step 2: Verify the edit reads coherently**

Run: `grep -n "compress\|code_search" skills/orchestrator/SKILL.md`
Expected: both new mentions present in the Context Hygiene area.

- [ ] **Step 3: Commit**

```bash
git add skills/orchestrator/SKILL.md
git commit -m "docs(orchestrator): route noisy output->compress, code location->code_search"
```

---

## Task 14: Full-suite verification + Ollama runtime notes

**Files:**
- Create: `agent/extensions/pi-compress/README.md`
- Create: `agent/extensions/pi-code-search/README.md`

- [ ] **Step 1: Run both extension test suites**

Run:
```bash
( cd agent/extensions/pi-compress && npx vitest run ) && ( cd agent/extensions/pi-code-search && npx vitest run )
```
Expected: all tests PASS in both packages.

- [ ] **Step 2: Type-check both packages**

Run:
```bash
( cd agent/extensions/pi-compress && npx tsc --noEmit ) && ( cd agent/extensions/pi-code-search && npx tsc --noEmit )
```
Expected: no errors.

- [ ] **Step 3: Document Ollama runtime expectations**

Create `agent/extensions/pi-compress/README.md`:
```markdown
# pi-compress

`compress` tool — distills noisy tool output to a verdict + the lines that matter, using a local model (Qwen2.5-Coder 3B via Ollama).

## Requirements
- Ollama running (`OLLAMA_HOST`, default `http://localhost:11434`).
- Models: `qwen2.5-coder:3b`.

## Recommended Ollama env (workspace-wide)
- `OLLAMA_MAX_LOADED_MODELS=2` — lets the 3b and the 14b coexist on 16GB.
- The 3b is pinned (`keep_alive: -1`) by these tools; the 14b uses a short keep-alive.

## Prompt
Single source of truth: `agent/agents/compressor.md`. Tune it there; re-run `scripts/smoke.mjs`.

## Disable
Set `COMPRESS_DISABLE=1`.
```

Create `agent/extensions/pi-code-search/README.md`:
```markdown
# pi-code-search

`code_search` tool — finds code by `file:line` WITHOUT reading files into context. Runs ripgrep, then a local model (Qwen2.5-Coder 3B via Ollama) picks + explains the best hits. No vector index.

## Requirements
- Ollama running with `qwen2.5-coder:3b`.
- `rg` (ripgrep) on PATH.

## Prompt
Single source of truth: `agent/agents/code-search.md`. Tune it there; re-run `scripts/smoke.mjs`.

## Disable
Set `CODE_SEARCH_DISABLE=1`.
```

- [ ] **Step 4: Final manual firewall check (requires Ollama)**

Confirm the three firewall paths end-to-end:
1. `node agent/extensions/pi-compress/scripts/smoke.mjs` → distilled failure.
2. `node agent/extensions/pi-code-search/scripts/smoke.mjs` → real `file:line` hits.
3. In a pi session, call `summarize` on a `.ts` file → confirm it uses qwen14b (check `ollama ps` shows the 14b loaded) and returns the structured code summary.

Expected: all three produce distilled output; no raw file/log bulk needed in the main context.

- [ ] **Step 5: Commit**

```bash
git add agent/extensions/pi-compress/README.md agent/extensions/pi-code-search/README.md
git commit -m "docs: pi-compress + pi-code-search READMEs with Ollama runtime notes"
```

---

## Done — Phase 1 outcome

The firewall is live: DeepSeek can now `summarize` (code-aware), `compress` noisy tool output, and `code_search` for `file:line` locations — all on local models, none of it dumping raw bulk into the cloud context. The orchestrator skill routes to them.

**Deferred to later plans:**
- Phase 2 — local sub-loops (bounded qwen14b mini-orchestrator for "map this dir" / "triage these failures").
- Phase 3 — rules-based router.
- Optionally: repoint the `scout` agent from `deepseek-v4-flash` to a local qwen14b, and add semantic search over `kb/` prose (only on demonstrated need).

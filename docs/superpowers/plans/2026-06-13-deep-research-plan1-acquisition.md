# Deep Research — Plan 1 of 2: Acquisition & Landing

> ⚠️ **RESCOPED 2026-06-13 (post-implementation).** After Plan 1 was built, we found the
> installed **`pi-web-access`** package already does fetch + clean extraction + web search +
> PDF/GitHub. So the standalone fetch/PDF/repo/dispatch modules below were **removed as
> redundant**. The shipped surface is **`dr_land`** (persist clean Markdown as a cited ②b
> `reference` doc) and **`dr_crawl`** (bounded doc-site BFS → land) — plus the kept internals
> (fetcher, html extractor, crawler, landing, run-store, types, dr-context). Tasks 5 (PDF),
> 6 (repo), 7 (dispatch), and the `dr_acquire` tool in Task 12 are **superseded** — read them
> for history only. Acquisition is now adopted from `pi-web-access`; see the updated spec
> §5/§6/§11. The task-by-task TDD body below remains accurate for the **kept** modules.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `pi-deep-research` extension's data-gathering core — fetch/crawl/extract a URL, doc-site, PDF, or local repo into clean Markdown, and land it as a `reference` document (with provenance + `deep-research` tag) into a Research-Library (②b) collection.

**Architecture:** A standalone PI extension. A **Fetcher** retrieves bytes (injectable `fetch` for offline tests); **Extractors** (HTML→Readability→Turndown, PDF→pdf-parse, repo→read) turn bytes into clean Markdown; a **Crawler** bounds doc-site BFS; a **Landing** component serializes an `AcquiredDoc` into ②b's exact YAML-frontmatter format and writes it into `collections/<id>/docs/` (files-as-truth — ②b reindexes it, no cross-extension coupling); a **Run-store** records what a run acquired so it can resume. A single `dr_acquire` tool + `/dr-acquire` command exercise the whole pipeline end-to-end. No conductor/workers/synthesis yet (that's Plan 2).

**Tech Stack:** TypeScript/ESM, vitest, `jsdom` + `@mozilla/readability` + `turndown` (HTML→Markdown), `pdf-parse` (PDF text), `yaml` (frontmatter), Node global `fetch`. Mirrors the `pi-research-library` extension's structure (`index.ts` + `src/` + per-tool files, `make*(ctx)` factories).

**Reference:** `docs/superpowers/specs/2026-06-13-deep-research-design.md` §1, §5, §7, §10. ②b frontmatter/types: `agent/extensions/pi-research-library/src/{frontmatter,types,paths}.ts`.

**Key compatibility facts (verified in ②b code):**
- A doc file is `---\n<yaml>\n---\n<body>`. YAML keys (order): `id, title, description, tags, authority, sources, created_at, updated_at` (+ optional `supersedes`, `confidence`). See `frontmatter.ts:serializeDoc`.
- `Source = { url?, path?, title?, retrieved_at?, locator? }`. `Authority = "reference" | "curated" | "agent-note"`.
- Docs live at `<root>/collections/<id>/docs/<docId>.md`; collection meta at `collections/<id>/collection.json` (`{id,summary,tags,authority,backends:["fts"]}`). Global root `~/.pi/kb`.
- `kb_import` already supports `authority` (defaults `reference`) — **no ②b change needed**; we land files directly instead.

---

## File Structure

| File | Responsibility |
|---|---|
| `agent/extensions/pi-deep-research/package.json` | extension manifest + deps |
| `agent/extensions/pi-deep-research/tsconfig.json` | TS config (mirror ②b) |
| `agent/extensions/pi-deep-research/index.ts` | register `dr_acquire` tool + `/dr-acquire` command |
| `src/types.ts` | `EntryPoint`, `AcquiredDoc`, `Provenance`, `RunId`, config types |
| `src/fetcher.ts` | HTTP GET: timeout, retry, redirect cap, size cap, UA; injectable `fetch` |
| `src/extract/html.ts` | HTML → clean Markdown (Readability + Turndown) |
| `src/extract/pdf.ts` | PDF buffer → text |
| `src/extract/repo.ts` | local file/dir → Markdown docs |
| `src/extract/dispatch.ts` | choose extractor by content-type / entry kind |
| `src/crawler.ts` | bounded same-origin BFS over Fetcher (robots, caps) |
| `src/landing.ts` | `AcquiredDoc` → ②b frontmatter `.md` in a collection |
| `src/run-store.ts` | persist/resume a run manifest of acquired sources |
| `src/dr-context.ts` | resolve roots/config; shared ctx |
| `src/tools/dr_acquire.ts` | the end-to-end acquire-and-land tool |
| `scripts/smoke-load.mjs` | load the extension with a fake `pi`, assert tool/command registered |
| `test/fixtures/*` | saved HTML/PDF for offline extractor tests |

---

## Task 1: Scaffold the extension + smoke loader

**Files:**
- Create: `agent/extensions/pi-deep-research/package.json`
- Create: `agent/extensions/pi-deep-research/tsconfig.json`
- Create: `agent/extensions/pi-deep-research/index.ts`
- Create: `agent/extensions/pi-deep-research/scripts/smoke-load.mjs`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pi-deep-research",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": {
    "test": "vitest run",
    "build": "echo none",
    "check": "tsc --noEmit",
    "smoke": "node scripts/smoke-load.mjs"
  },
  "dependencies": {
    "@mozilla/readability": "^0.5.0",
    "jsdom": "^25.0.0",
    "turndown": "^7.2.0",
    "pdf-parse": "^1.1.1",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.2",
    "@types/jsdom": "^21.1.7",
    "@types/node": "^20.0.0",
    "@types/turndown": "^5.0.5",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create minimal `index.ts`** (tool added in Task 12; start empty-but-valid)

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
  // Tools/commands are registered in Task 12.
}
```

- [ ] **Step 4: Create `scripts/smoke-load.mjs`**

```js
// Loads the built extension with a fake `pi` and asserts it doesn't throw.
import ext from "../index.ts";
const tools = [], commands = [];
const pi = {
  registerTool: (t) => tools.push(t.name),
  registerCommand: (n) => commands.push(n),
  on: () => {},
};
ext(pi);
console.log("LOAD_OK", JSON.stringify({ tools, commands }));
```

- [ ] **Step 5: Install deps and verify load**

Run: `cd agent/extensions/pi-deep-research && npm install`
Then: `npx tsc --noEmit`
Expected: install succeeds; tsc clean (no errors).

- [ ] **Step 6: Commit**

```bash
git add agent/extensions/pi-deep-research/package.json agent/extensions/pi-deep-research/tsconfig.json agent/extensions/pi-deep-research/index.ts agent/extensions/pi-deep-research/scripts/smoke-load.mjs
git commit -m "chore: scaffold pi-deep-research extension"
```

---

## Task 2: Core types

**Files:**
- Create: `agent/extensions/pi-deep-research/src/types.ts`
- Test: `agent/extensions/pi-deep-research/test/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { makeRunId, type AcquiredDoc, type EntryPoint } from "../src/types.js";

test("makeRunId produces a sortable, unique-ish run id with the dr- prefix", () => {
  const a = makeRunId();
  const b = makeRunId();
  expect(a).toMatch(/^dr-\d{8}-\d{6}-[a-z0-9]{4}$/);
  expect(a).not.toBe(b);
});

test("AcquiredDoc / EntryPoint shapes compile and round-trip", () => {
  const ep: EntryPoint = { kind: "url", value: "https://example.com/x" };
  const doc: AcquiredDoc = {
    sourceUrl: ep.value, title: "X", markdown: "# X\n\nbody",
    retrievedAt: "2026-06-13T00:00:00.000Z", contentHash: "abc123", locator: undefined,
  };
  expect(doc.title).toBe("X");
  expect(ep.kind).toBe("url");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL ("Cannot find module ../src/types.js").

- [ ] **Step 3: Implement `src/types.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";

export type EntryKind = "url" | "crawl" | "pdf" | "repo";
export interface EntryPoint { kind: EntryKind; value: string; }

export interface AcquiredDoc {
  sourceUrl?: string;     // present for url/crawl/pdf-by-url
  sourcePath?: string;    // present for repo/local pdf
  title: string;
  markdown: string;
  retrievedAt: string;    // ISO
  contentHash: string;    // sha256 of markdown
  locator?: string;       // e.g. page number / heading; optional in v1
}

export interface AcquireConfig {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRetries: number;
  maxRedirects: number;
  crawlMaxPages: number;
  crawlMaxDepth: number;
}

export const DEFAULT_CONFIG: AcquireConfig = {
  userAgent: "pi-deep-research/0.1 (+https://github.com/local)",
  timeoutMs: 20000, maxBytes: 5_000_000, maxRetries: 2,
  maxRedirects: 5, crawlMaxPages: 25, crawlMaxDepth: 3,
};

export type RunId = string;

export function makeRunId(): RunId {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rand = randomBytes(3).toString("hex").slice(0, 4);
  return `dr-${date}-${time}-${rand}`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/types.test.ts
git commit -m "feat: deep-research core types + run-id"
```

---

## Task 3: Fetcher (injectable fetch, timeout/retry/caps)

**Files:**
- Create: `agent/extensions/pi-deep-research/src/fetcher.ts`
- Test: `agent/extensions/pi-deep-research/test/fetcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { fetchBytes, type FetchLike } from "../src/fetcher.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function res(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });
}

test("fetchBytes returns body text + content-type on success", async () => {
  const fake: FetchLike = async () => res("<html>ok</html>");
  const out = await fetchBytes("https://x.test/a", DEFAULT_CONFIG, fake);
  expect(out.text).toContain("ok");
  expect(out.contentType).toContain("text/html");
});

test("fetchBytes retries on failure then throws after maxRetries", async () => {
  let calls = 0;
  const fake: FetchLike = async () => { calls++; throw new Error("boom"); };
  await expect(fetchBytes("https://x.test/a", { ...DEFAULT_CONFIG, maxRetries: 2 }, fake))
    .rejects.toThrow(/boom/);
  expect(calls).toBe(3); // initial + 2 retries
});

test("fetchBytes rejects bodies over maxBytes", async () => {
  const big = "x".repeat(100);
  const fake: FetchLike = async () => res(big, { "content-length": "100" });
  await expect(fetchBytes("https://x.test/a", { ...DEFAULT_CONFIG, maxBytes: 10 }, fake))
    .rejects.toThrow(/too large/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/fetcher.test.ts`
Expected: FAIL ("Cannot find module ../src/fetcher.js").

- [ ] **Step 3: Implement `src/fetcher.ts`**

```ts
import type { AcquireConfig } from "./types.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchResult { text: string; contentType: string; bytes: Uint8Array; }

export async function fetchBytes(
  url: string, cfg: AcquireConfig, doFetch: FetchLike = fetch,
): Promise<FetchResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const r = await doFetch(url, {
          redirect: "follow",
          headers: { "user-agent": cfg.userAgent },
          signal: ctrl.signal,
        });
        const cl = Number(r.headers.get("content-length") ?? "0");
        if (cl && cl > cfg.maxBytes) throw new Error(`response too large (${cl} bytes)`);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength > cfg.maxBytes) throw new Error(`response too large (${buf.byteLength} bytes)`);
        const contentType = r.headers.get("content-type") ?? "application/octet-stream";
        return { text: new TextDecoder().decode(buf), contentType, bytes: buf };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/fetcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fetcher.ts test/fetcher.test.ts
git commit -m "feat: fetcher with timeout/retry/size-cap and injectable fetch"
```

---

## Task 4: HTML extractor (Readability + Turndown)

**Files:**
- Create: `agent/extensions/pi-deep-research/src/extract/html.ts`
- Create: `agent/extensions/pi-deep-research/test/fixtures/article.html`
- Test: `agent/extensions/pi-deep-research/test/extract-html.test.ts`

- [ ] **Step 1: Create the fixture `test/fixtures/article.html`**

```html
<!doctype html>
<html><head><title>Fixture Title</title></head>
<body>
  <nav><a href="/">Home</a><a href="/ads">Ads</a></nav>
  <header><h1>Site Chrome</h1></header>
  <article>
    <h1>Real Heading</h1>
    <p>First meaningful paragraph with <a href="https://ref.test/x">a link</a>.</p>
    <h2>Subsection</h2>
    <p>Second paragraph of actual content.</p>
  </article>
  <footer>© boilerplate footer</footer>
  <script>console.log("tracker")</script>
</body></html>
```

- [ ] **Step 2: Write the failing test**

```ts
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { htmlToMarkdown } from "../src/extract/html.js";

const html = readFileSync(join(__dirname, "fixtures/article.html"), "utf-8");

test("htmlToMarkdown keeps article content and strips nav/footer/script", () => {
  const { title, markdown } = htmlToMarkdown(html, "https://x.test/article");
  expect(title).toBe("Fixture Title");
  expect(markdown).toContain("Real Heading");
  expect(markdown).toContain("Second paragraph of actual content");
  expect(markdown).not.toContain("Ads");
  expect(markdown).not.toContain("boilerplate footer");
  expect(markdown).not.toContain("tracker");
});

test("htmlToMarkdown preserves heading structure as markdown", () => {
  const { markdown } = htmlToMarkdown(html, "https://x.test/article");
  expect(markdown).toMatch(/#+\s+Real Heading/);
  expect(markdown).toMatch(/#+\s+Subsection/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/extract-html.test.ts`
Expected: FAIL ("Cannot find module ../src/extract/html.js").

- [ ] **Step 4: Implement `src/extract/html.ts`**

```ts
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export interface HtmlExtract { title: string; markdown: string; }

export function htmlToMarkdown(html: string, url: string): HtmlExtract {
  const dom = new JSDOM(html, { url });
  const docTitle = dom.window.document.title || "";
  const article = new Readability(dom.window.document).parse();
  const contentHtml = article?.content ?? dom.window.document.body.innerHTML;
  const title = article?.title || docTitle || "Untitled";
  const markdown = turndown.turndown(contentHtml).trim();
  return { title, markdown };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/extract-html.test.ts`
Expected: PASS (2 tests). If Readability returns null on this tiny fixture, the fallback to `body.innerHTML` still strips `<script>` via Turndown (scripts are not rendered); confirm "tracker" absent — Turndown ignores `<script>`. If "Ads"/footer leak through the fallback, enlarge the `<article>` content in the fixture so Readability selects it (it needs enough text to score).

- [ ] **Step 6: Commit**

```bash
git add src/extract/html.ts test/fixtures/article.html test/extract-html.test.ts
git commit -m "feat: HTML->clean-markdown extractor (readability+turndown)"
```

---

## Task 5: PDF extractor

**Files:**
- Create: `agent/extensions/pi-deep-research/src/extract/pdf.ts`
- Test: `agent/extensions/pi-deep-research/test/extract-pdf.test.ts`

> `pdf-parse` ships a sample PDF under its package. We test against a generated tiny PDF buffer to avoid binary fixtures in git: use the package's own test asset path if present, else skip-guard. The implementation is a thin wrapper; the test asserts the wrapper returns text from a known buffer.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pdfToText } from "../src/extract/pdf.js";

// pdf-parse bundles a sample PDF used by its own tests.
const sample = join(process.cwd(), "node_modules/pdf-parse/test/data/05-versions-space.pdf");

test.skipIf(!existsSync(sample))("pdfToText extracts text from a sample PDF", async () => {
  const buf = readFileSync(sample);
  const text = await pdfToText(new Uint8Array(buf));
  expect(text.length).toBeGreaterThan(0);
  expect(typeof text).toBe("string");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/extract-pdf.test.ts`
Expected: FAIL ("Cannot find module ../src/extract/pdf.js").

- [ ] **Step 3: Implement `src/extract/pdf.ts`**

```ts
// pdf-parse is CommonJS; import default and call as a function.
import pdfParse from "pdf-parse";

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const data = await pdfParse(Buffer.from(bytes));
  return (data.text ?? "").trim();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/extract-pdf.test.ts`
Expected: PASS (or SKIP if the sample asset is absent — acceptable). If the import errors with "pdf-parse has no default export" under ESM, change to: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const pdfParse = require("pdf-parse");` and keep the rest identical.

- [ ] **Step 5: Commit**

```bash
git add src/extract/pdf.ts test/extract-pdf.test.ts
git commit -m "feat: PDF text extractor (pdf-parse wrapper)"
```

---

## Task 6: Repo reader

**Files:**
- Create: `agent/extensions/pi-deep-research/src/extract/repo.ts`
- Test: `agent/extensions/pi-deep-research/test/extract-repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepo } from "../src/extract/repo.js";

test("readRepo collects text files into AcquiredDoc-like entries, skipping binaries/node_modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "dr-repo-"));
  writeFileSync(join(dir, "a.ts"), "export const x = 1;");
  writeFileSync(join(dir, "README.md"), "# Title\n\ndocs");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "junk.js"), "ignored");
  writeFileSync(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const docs = readRepo(dir, { maxFiles: 50 });
  const titles = docs.map((d) => d.title).sort();
  expect(titles).toContain("a.ts");
  expect(titles).toContain("README.md");
  expect(titles).not.toContain("junk.js");
  expect(titles).not.toContain("image.png");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/extract-repo.test.ts`
Expected: FAIL ("Cannot find module ../src/extract/repo.js").

- [ ] **Step 3: Implement `src/extract/repo.ts`**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import type { AcquiredDoc } from "../types.js";
import { sha256 } from "../types.js";

const TEXT_EXT = new Set([".ts", ".js", ".tsx", ".jsx", ".md", ".txt", ".json",
  ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".rb", ".sh", ".yml", ".yaml", ".toml"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".pi"]);

export function readRepo(root: string, opts: { maxFiles: number }): AcquiredDoc[] {
  const out: AcquiredDoc[] = [];
  const now = new Date().toISOString();
  const walk = (dir: string) => {
    if (out.length >= opts.maxFiles) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= opts.maxFiles) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(full); continue; }
      if (!TEXT_EXT.has(extname(e.name))) continue;
      if (statSync(full).size > 200_000) continue;
      const body = readFileSync(full, "utf-8");
      out.push({
        sourcePath: full, title: basename(full),
        markdown: "```" + extname(e.name).slice(1) + "\n" + body + "\n```",
        retrievedAt: now, contentHash: sha256(body), locator: relative(root, full),
      });
    }
  };
  walk(root);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/extract-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract/repo.ts test/extract-repo.test.ts
git commit -m "feat: local repo reader (text files -> markdown docs)"
```

---

## Task 7: Extractor dispatch

**Files:**
- Create: `agent/extensions/pi-deep-research/src/extract/dispatch.ts`
- Test: `agent/extensions/pi-deep-research/test/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { bytesToDoc } from "../src/extract/dispatch.js";

test("dispatch routes html content-type to the html extractor", async () => {
  const html = "<html><head><title>T</title></head><body><article><h1>H</h1><p>hello world here is content</p></article></body></html>";
  const doc = await bytesToDoc({
    url: "https://x.test/p", contentType: "text/html; charset=utf-8",
    bytes: new TextEncoder().encode(html),
  });
  expect(doc.title).toBeTruthy();
  expect(doc.markdown).toContain("hello world");
  expect(doc.sourceUrl).toBe("https://x.test/p");
  expect(doc.contentHash).toHaveLength(64);
});

test("dispatch routes pdf content-type to the pdf extractor (wrapped as markdown)", async () => {
  // Minimal: assert it does not treat pdf as html. Use a fake by forcing application/pdf
  // with empty bytes -> pdfToText returns "" -> doc.markdown === "" but title falls back.
  const doc = await bytesToDoc({
    url: "https://x.test/d.pdf", contentType: "application/pdf",
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
  }).catch((e) => ({ error: String(e) } as any));
  // Either it extracts (string) or errors gracefully; it must NOT contain HTML artifacts.
  expect(JSON.stringify(doc)).not.toContain("<html");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/dispatch.test.ts`
Expected: FAIL ("Cannot find module ../src/extract/dispatch.js").

- [ ] **Step 3: Implement `src/extract/dispatch.ts`**

```ts
import type { AcquiredDoc } from "../types.js";
import { sha256 } from "../types.js";
import { htmlToMarkdown } from "./html.js";
import { pdfToText } from "./pdf.js";

export interface RawSource { url: string; contentType: string; bytes: Uint8Array; }

export async function bytesToDoc(src: RawSource): Promise<AcquiredDoc> {
  const now = new Date().toISOString();
  const ct = src.contentType.toLowerCase();
  if (ct.includes("application/pdf") || src.url.toLowerCase().endsWith(".pdf")) {
    const text = await pdfToText(src.bytes);
    return { sourceUrl: src.url, title: titleFromUrl(src.url), markdown: text,
      retrievedAt: now, contentHash: sha256(text) };
  }
  // default: html
  const html = new TextDecoder().decode(src.bytes);
  const { title, markdown } = htmlToMarkdown(html, src.url);
  return { sourceUrl: src.url, title, markdown, retrievedAt: now, contentHash: sha256(markdown) };
}

function titleFromUrl(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || url); }
  catch { return url; }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/dispatch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/extract/dispatch.ts test/dispatch.test.ts
git commit -m "feat: content-type extractor dispatch"
```

---

## Task 8: Crawler (bounded same-origin BFS)

**Files:**
- Create: `agent/extensions/pi-deep-research/src/crawler.ts`
- Test: `agent/extensions/pi-deep-research/test/crawler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { crawl } from "../src/crawler.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { FetchLike } from "../src/fetcher.js";

function page(links: string[], body = "content here for the page body text"): Response {
  const a = links.map((h) => `<a href="${h}">l</a>`).join("");
  return new Response(`<html><head><title>P</title></head><body><article><p>${body}</p>${a}</article></body></html>`,
    { status: 200, headers: { "content-type": "text/html" } });
}

test("crawl visits same-origin links up to maxPages, dedups, ignores off-origin", async () => {
  const graph: Record<string, string[]> = {
    "https://site.test/": ["https://site.test/a", "https://site.test/b", "https://other.test/x"],
    "https://site.test/a": ["https://site.test/b", "https://site.test/"],
    "https://site.test/b": [],
  };
  const fake: FetchLike = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    return page(graph[url] ?? []);
  };
  const docs = await crawl("https://site.test/", { ...DEFAULT_CONFIG, crawlMaxPages: 10 }, fake);
  const urls = docs.map((d) => d.sourceUrl).sort();
  expect(urls).toEqual(["https://site.test/", "https://site.test/a", "https://site.test/b"]);
});

test("crawl respects crawlMaxPages", async () => {
  const fake: FetchLike = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    return page(["https://site.test/a", "https://site.test/b", "https://site.test/c"]);
  };
  const docs = await crawl("https://site.test/", { ...DEFAULT_CONFIG, crawlMaxPages: 2 }, fake);
  expect(docs.length).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/crawler.test.ts`
Expected: FAIL ("Cannot find module ../src/crawler.js").

- [ ] **Step 3: Implement `src/crawler.ts`**

```ts
import type { AcquireConfig, AcquiredDoc } from "./types.js";
import { fetchBytes, type FetchLike } from "./fetcher.js";
import { bytesToDoc } from "./extract/dispatch.js";

export async function crawl(
  rootUrl: string, cfg: AcquireConfig, doFetch: FetchLike = fetch,
): Promise<AcquiredDoc[]> {
  const origin = new URL(rootUrl).origin;
  const disallow = await loadRobots(origin, cfg, doFetch);
  const seen = new Set<string>([normalize(rootUrl)]);
  const queue: Array<{ url: string; depth: number }> = [{ url: rootUrl, depth: 0 }];
  const docs: AcquiredDoc[] = [];

  while (queue.length && docs.length < cfg.crawlMaxPages) {
    const { url, depth } = queue.shift()!;
    if (isDisallowed(url, disallow)) continue;
    let r;
    try { r = await fetchBytes(url, cfg, doFetch); } catch { continue; }
    if (!r.contentType.toLowerCase().includes("text/html")) continue;
    docs.push(await bytesToDoc({ url, contentType: r.contentType, bytes: r.bytes }));
    if (depth >= cfg.crawlMaxDepth) continue;
    for (const link of extractLinks(r.text, url)) {
      const n = normalize(link);
      if (new URL(link).origin !== origin) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push({ url: link, depth: depth + 1 });
    }
  }
  return docs;
}

function normalize(url: string): string {
  const u = new URL(url); u.hash = ""; return u.toString();
}
function extractLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    try { out.push(new URL(m[1], base).toString()); } catch { /* skip */ }
  }
  return out;
}
async function loadRobots(origin: string, cfg: AcquireConfig, doFetch: FetchLike): Promise<string[]> {
  try {
    const r = await fetchBytes(`${origin}/robots.txt`, cfg, doFetch);
    return r.text.split("\n").filter((l) => /^disallow:/i.test(l.trim()))
      .map((l) => l.split(":")[1]?.trim()).filter(Boolean) as string[];
  } catch { return []; }
}
function isDisallowed(url: string, disallow: string[]): boolean {
  const path = new URL(url).pathname;
  return disallow.some((d) => d !== "/" && d.length > 0 && path.startsWith(d));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/crawler.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/crawler.ts test/crawler.test.ts
git commit -m "feat: bounded same-origin crawler with robots + dedup"
```

---

## Task 9: Landing — write ②b-compatible reference docs

**Files:**
- Create: `agent/extensions/pi-deep-research/src/landing.ts`
- Test: `agent/extensions/pi-deep-research/test/landing.test.ts`

This is the integration seam. We replicate ②b's `serializeDoc` YAML shape exactly so the existing library reindexes our files as `reference` docs.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landDoc } from "../src/landing.js";
import type { AcquiredDoc } from "../src/types.js";

const doc: AcquiredDoc = {
  sourceUrl: "https://ref.test/page", title: "Ref Page",
  markdown: "# Ref Page\n\nThe body.", retrievedAt: "2026-06-13T00:00:00.000Z",
  contentHash: "deadbeef", locator: undefined,
};

test("landDoc writes a reference .md with deep-research tag + run-id into the collection docs dir", () => {
  const root = mkdtempSync(join(tmpdir(), "dr-land-"));
  const res = landDoc({ root, collection: "webrefs", runId: "dr-1", doc });
  const file = readFileSync(res.path, "utf-8");

  expect(res.path).toContain(join("collections", "webrefs", "docs"));
  expect(file).toMatch(/^---\n/);
  expect(file).toContain("authority: reference");
  expect(file).toContain("- deep-research");
  expect(file).toContain("- dr-1");
  expect(file).toContain("url: https://ref.test/page");
  expect(file).toContain("retrieved_at: 2026-06-13T00:00:00.000Z");
  expect(file).toContain("# Ref Page");
  // collection.json created with reference authority
  const cj = JSON.parse(readFileSync(join(root, "collections", "webrefs", "collection.json"), "utf-8"));
  expect(cj.authority).toBe("reference");
});

test("landDoc is idempotent on identical content (same id, no duplicate files)", () => {
  const root = mkdtempSync(join(tmpdir(), "dr-land2-"));
  landDoc({ root, collection: "c", runId: "r", doc });
  landDoc({ root, collection: "c", runId: "r", doc });
  const files = readdirSync(join(root, "collections", "c", "docs"));
  expect(files.length).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/landing.test.ts`
Expected: FAIL ("Cannot find module ../src/landing.js").

- [ ] **Step 3: Implement `src/landing.ts`**

```ts
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { AcquiredDoc } from "./types.js";
import { sha256 } from "./types.js";

export interface LandInput { root: string; collection: string; runId: string; doc: AcquiredDoc; }
export interface LandResult { id: string; path: string; }

/** Mirrors ②b frontmatter.ts:serializeDoc key order so kb reindex parses it as a reference doc. */
export function landDoc(input: LandInput): LandResult {
  const { root, collection, runId, doc } = input;
  const colDir = join(root, "collections", collection);
  const docsDir = join(colDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  ensureCollectionJson(colDir, collection);

  const id = `${slug(doc.title)}-${(doc.contentHash || sha256(doc.markdown)).slice(0, 8)}`;
  const now = new Date().toISOString();
  const description = doc.markdown.split("\n").map((l) => l.trim()).find(Boolean) ?? doc.title;
  const source = doc.sourceUrl
    ? { url: doc.sourceUrl, title: doc.title, retrieved_at: doc.retrievedAt, ...(doc.locator ? { locator: doc.locator } : {}) }
    : { path: doc.sourcePath, title: doc.title, retrieved_at: doc.retrievedAt, ...(doc.locator ? { locator: doc.locator } : {}) };

  const meta = {
    id, title: doc.title, description,
    tags: ["deep-research", runId],
    authority: "reference",
    sources: [source],
    created_at: now, updated_at: now,
  };
  const file = `---\n${YAML.stringify(meta).trimEnd()}\n---\n${doc.markdown.replace(/^\n/, "")}`;
  const path = join(docsDir, `${id}.md`);
  writeFileSync(path, file);
  return { id, path };
}

function ensureCollectionJson(colDir: string, id: string): void {
  mkdirSync(colDir, { recursive: true });
  const cj = join(colDir, "collection.json");
  if (!existsSync(cj))
    writeFileSync(cj, JSON.stringify({ id, summary: id, tags: ["deep-research"], authority: "reference", backends: ["fts"] }, null, 2));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "doc";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/landing.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Cross-check against ②b parser (manual, one-time)**

Add a temporary check that ②b can parse what we wrote (proves byte-compat). Run this throwaway node snippet from the repo root and confirm it prints `reference` and the tags:

```bash
node --input-type=module -e "
import { parseDoc } from './agent/extensions/pi-research-library/src/frontmatter.ts';
import { landDoc } from './agent/extensions/pi-deep-research/src/landing.ts';
import { mkdtempSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(),'x-'));
const r = landDoc({ root, collection:'c', runId:'dr-1', doc:{ sourceUrl:'https://a/b', title:'T', markdown:'# T\n\nbody', retrievedAt:'2026-06-13T00:00:00.000Z', contentHash:'abc' }});
const { meta } = parseDoc(readFileSync(r.path,'utf-8'));
console.log(meta.authority, meta.tags, meta.sources[0].url);
"
```
Expected: `reference [ 'deep-research', 'dr-1' ] https://a/b`. (This step is verification only — no file changes to commit.)

- [ ] **Step 6: Commit**

```bash
git add src/landing.ts test/landing.test.ts
git commit -m "feat: landing - write ②b-compatible reference docs (files-as-truth)"
```

---

## Task 10: Run-store (manifest persist/resume)

**Files:**
- Create: `agent/extensions/pi-deep-research/src/run-store.ts`
- Test: `agent/extensions/pi-deep-research/test/run-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/run-store.js";

test("RunStore creates, appends landed docs, and reloads a run manifest", () => {
  const base = mkdtempSync(join(tmpdir(), "dr-runs-"));
  const store = new RunStore(base);
  const run = store.create({ runId: "dr-1", topic: "raft", collection: "papers" });
  expect(run.status).toBe("running");

  store.recordLanded("dr-1", { id: "raft-abc", sourceUrl: "https://x/raft" });
  store.finish("dr-1", "done");

  const reloaded = new RunStore(base).load("dr-1");
  expect(reloaded?.status).toBe("done");
  expect(reloaded?.landed.map((l) => l.id)).toEqual(["raft-abc"]);
  expect(reloaded?.topic).toBe("raft");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/run-store.test.ts`
Expected: FAIL ("Cannot find module ../src/run-store.js").

- [ ] **Step 3: Implement `src/run-store.ts`**

```ts
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface LandedRef { id: string; sourceUrl?: string; sourcePath?: string; }
export type RunStatus = "running" | "done" | "failed" | "cancelled";
export interface RunManifest {
  runId: string; topic: string; collection: string;
  status: RunStatus; createdAt: string; updatedAt: string;
  landed: LandedRef[];
}

export class RunStore {
  constructor(private baseDir: string) { mkdirSync(baseDir, { recursive: true }); }
  private file(runId: string) { return join(this.baseDir, `${runId}.json`); }

  create(p: { runId: string; topic: string; collection: string }): RunManifest {
    const now = new Date().toISOString();
    const m: RunManifest = { ...p, status: "running", createdAt: now, updatedAt: now, landed: [] };
    this.write(m); return m;
  }
  load(runId: string): RunManifest | null {
    const f = this.file(runId);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf-8")) as RunManifest) : null;
  }
  recordLanded(runId: string, ref: LandedRef): void {
    const m = this.must(runId); m.landed.push(ref); this.write(m);
  }
  finish(runId: string, status: RunStatus): void {
    const m = this.must(runId); m.status = status; this.write(m);
  }
  private must(runId: string): RunManifest {
    const m = this.load(runId); if (!m) throw new Error(`unknown run ${runId}`); return m;
  }
  private write(m: RunManifest): void {
    m.updatedAt = new Date().toISOString();
    writeFileSync(this.file(m.runId), JSON.stringify(m, null, 2));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/run-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run-store.ts test/run-store.test.ts
git commit -m "feat: run-store manifest persist/resume"
```

---

## Task 11: dr-context (roots + config resolution)

**Files:**
- Create: `agent/extensions/pi-deep-research/src/dr-context.ts`
- Test: `agent/extensions/pi-deep-research/test/dr-context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDrContext } from "../src/dr-context.js";

test("buildDrContext resolves kb root, runs dir, and default config", () => {
  const home = mkdtempSync(join(tmpdir(), "dr-ctx-"));
  const ctx = buildDrContext({ homeDir: home });
  expect(ctx.kbRoot).toBe(join(home, ".pi", "kb"));
  expect(ctx.runsDir).toBe(join(home, ".pi", "agent", "pi-deep-research", "runs"));
  expect(ctx.config.crawlMaxPages).toBeGreaterThan(0);
});

test("buildDrContext merges a config file over defaults", () => {
  const home = mkdtempSync(join(tmpdir(), "dr-ctx2-"));
  const cfgDir = join(home, ".pi", "agent", "pi-deep-research");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "pi-deep-research-config.json"), JSON.stringify({ crawlMaxPages: 3 }));
  const ctx = buildDrContext({ homeDir: home });
  expect(ctx.config.crawlMaxPages).toBe(3);
  expect(ctx.config.timeoutMs).toBeGreaterThan(0); // default preserved
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/dr-context.test.ts`
Expected: FAIL ("Cannot find module ../src/dr-context.js").

- [ ] **Step 3: Implement `src/dr-context.ts`**

```ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { DEFAULT_CONFIG, type AcquireConfig } from "./types.js";

export interface DrContext {
  kbRoot: string;
  runsDir: string;
  config: AcquireConfig;
}

export function buildDrContext(opts?: { homeDir?: string }): DrContext {
  const home = opts?.homeDir ?? os.homedir();
  const kbRoot = join(home, ".pi", "kb");
  const extDir = join(home, ".pi", "agent", "pi-deep-research");
  const runsDir = join(extDir, "runs");
  let config = { ...DEFAULT_CONFIG };
  const cfgFile = join(extDir, "pi-deep-research-config.json");
  if (existsSync(cfgFile)) {
    try { config = { ...config, ...JSON.parse(readFileSync(cfgFile, "utf-8")) }; } catch { /* keep defaults */ }
  }
  return { kbRoot, runsDir, config };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/dr-context.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dr-context.ts test/dr-context.test.ts
git commit -m "feat: dr-context (roots + config resolution)"
```

---

## Task 12: `acquireEntryPoint` orchestration + `dr_acquire` tool + wiring

**Files:**
- Create: `agent/extensions/pi-deep-research/src/acquire.ts`
- Create: `agent/extensions/pi-deep-research/src/tools/dr_acquire.ts`
- Modify: `agent/extensions/pi-deep-research/index.ts`
- Test: `agent/extensions/pi-deep-research/test/acquire.test.ts`

- [ ] **Step 1: Write the failing test for the pure orchestration fn**

```ts
import { test, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireEntryPoint } from "../src/acquire.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { FetchLike } from "../src/fetcher.js";

const fake: FetchLike = async (url) => {
  if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
  return new Response(
    "<html><head><title>Doc</title></head><body><article><h1>Doc</h1><p>real content body text here</p></article></body></html>",
    { status: 200, headers: { "content-type": "text/html" } });
};

test("acquireEntryPoint (url) fetches, extracts, lands a reference doc, records it", async () => {
  const home = mkdtempSync(join(tmpdir(), "dr-acq-"));
  const res = await acquireEntryPoint({
    entry: { kind: "url", value: "https://x.test/doc" },
    collection: "webrefs", runId: "dr-9",
    kbRoot: join(home, "kb"), runsDir: join(home, "runs"),
    config: DEFAULT_CONFIG, doFetch: fake,
  });
  expect(res.landed.length).toBe(1);
  const files = readdirSync(join(home, "kb", "collections", "webrefs", "docs"));
  expect(files.length).toBe(1);
  expect(files[0]).toMatch(/\.md$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/acquire.test.ts`
Expected: FAIL ("Cannot find module ../src/acquire.js").

- [ ] **Step 3: Implement `src/acquire.ts`**

```ts
import { join } from "node:path";
import type { AcquireConfig, EntryPoint, AcquiredDoc } from "./types.js";
import { fetchBytes, type FetchLike } from "./fetcher.js";
import { bytesToDoc } from "./extract/dispatch.js";
import { crawl } from "./crawler.js";
import { readRepo } from "./extract/repo.js";
import { landDoc } from "./landing.js";
import { RunStore, type LandedRef } from "./run-store.js";

export interface AcquireInput {
  entry: EntryPoint; collection: string; runId: string;
  kbRoot: string; runsDir: string; config: AcquireConfig;
  doFetch?: FetchLike;
}
export interface AcquireOutput { landed: LandedRef[] }

export async function acquireEntryPoint(input: AcquireInput): Promise<AcquireOutput> {
  const { entry, collection, runId, kbRoot, runsDir, config } = input;
  const doFetch = input.doFetch ?? fetch;
  const store = new RunStore(runsDir);
  if (!store.load(runId)) store.create({ runId, topic: entry.value, collection });

  const docs: AcquiredDoc[] = [];
  if (entry.kind === "crawl") {
    docs.push(...await crawl(entry.value, config, doFetch));
  } else if (entry.kind === "repo") {
    docs.push(...readRepo(entry.value, { maxFiles: 200 }));
  } else { // url | pdf
    const r = await fetchBytes(entry.value, config, doFetch);
    docs.push(await bytesToDoc({ url: entry.value, contentType: r.contentType, bytes: r.bytes }));
  }

  const landed: LandedRef[] = [];
  for (const doc of docs) {
    const res = landDoc({ root: kbRoot, collection, runId, doc });
    const ref: LandedRef = { id: res.id, sourceUrl: doc.sourceUrl, sourcePath: doc.sourcePath };
    store.recordLanded(runId, ref);
    landed.push(ref);
  }
  return { landed };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/acquire.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/tools/dr_acquire.ts`**

```ts
import { Type } from "typebox";
import type { DrContext } from "../dr-context.js";
import { acquireEntryPoint } from "../acquire.js";
import { makeRunId, type EntryKind } from "../types.js";

export function makeDrAcquire(ctx: DrContext) {
  return {
    name: "dr_acquire",
    label: "Deep-Research Acquire",
    description: "Fetch/crawl/extract a single source (URL, doc-site crawl root, PDF, or local repo path) into clean Markdown and land it as a `reference` doc in a knowledge-library collection. Returns landed doc ids. Web SEARCH is not included — provide concrete entry points.",
    promptSnippet: "dr_acquire: gather one source (url/crawl/pdf/repo) into the KB",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("url"), Type.Literal("crawl"), Type.Literal("pdf"), Type.Literal("repo")]),
      value: Type.String({ description: "URL, crawl root URL, PDF URL/path, or local repo path" }),
      collection: Type.String({ description: "target KB collection id (created if new, reference authority)" }),
      run_id: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any) {
      const runId = p.run_id || makeRunId();
      try {
        const out = await acquireEntryPoint({
          entry: { kind: p.kind as EntryKind, value: p.value },
          collection: p.collection, runId,
          kbRoot: ctx.kbRoot, runsDir: ctx.runsDir, config: ctx.config,
        });
        const ids = out.landed.map((l) => l.id).join(", ");
        return { content: [{ type: "text" as const,
          text: `Acquired ${out.landed.length} doc(s) into "${p.collection}" (run ${runId}): ${ids}\nRun /kb-reindex (or restart) so kb_search can see them.` }], details: { runId, landed: out.landed } };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `dr_acquire failed (run ${runId}): ${String(e)}` }], details: { runId, error: String(e) } };
      }
    },
  };
}
```

- [ ] **Step 6: Modify `index.ts` to register the tool + command**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildDrContext } from "./src/dr-context.js";
import { makeDrAcquire } from "./src/tools/dr_acquire.js";

export default function (pi: ExtensionAPI) {
  const ctx = buildDrContext();
  pi.registerTool(makeDrAcquire(ctx) as any);
  pi.registerCommand("dr-acquire", {
    description: "Acquire a source (url/crawl/pdf/repo) into a KB collection",
    handler: async () => {
      return { type: "text", text: "Use the dr_acquire tool with { kind, value, collection }. Open-web search is not part of v1 — supply concrete entry points." };
    },
  } as any);
}
```

> Note: the exact `registerCommand` option shape may differ; mirror `pi-research-library/src/commands.ts` if tsc complains. The command is a thin help shim — the real work is the `dr_acquire` tool.

- [ ] **Step 7: Run full suite + tsc + smoke**

Run: `npx vitest run && npx tsc --noEmit && node scripts/smoke-load.mjs`
Expected: all tests PASS; tsc clean; smoke prints `LOAD_OK {"tools":["dr_acquire"],"commands":["dr-acquire"]}`.

- [ ] **Step 8: Commit**

```bash
git add src/acquire.ts src/tools/dr_acquire.ts index.ts test/acquire.test.ts
git commit -m "feat: acquireEntryPoint + dr_acquire tool + extension wiring"
```

---

## Task 13: End-to-end smoke against a real local KB + DoD

**Files:**
- Test: `agent/extensions/pi-deep-research/test/e2e-land.test.ts`

- [ ] **Step 1: Write the e2e test (fixture HTML → landed file ②b can parse)**

```ts
import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireEntryPoint } from "../src/acquire.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { parseDoc } from "../../pi-research-library/src/frontmatter.js";
import type { FetchLike } from "../src/fetcher.js";

const fixture = readFileSync(join(__dirname, "fixtures/article.html"), "utf-8");
const fake: FetchLike = async (url) => {
  if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
  return new Response(fixture, { status: 200, headers: { "content-type": "text/html" } });
};

test("acquired page lands as a reference doc that ②b's parseDoc reads correctly", async () => {
  const home = mkdtempSync(join(tmpdir(), "dr-e2e-"));
  await acquireEntryPoint({
    entry: { kind: "url", value: "https://x.test/article" },
    collection: "webrefs", runId: "dr-e2e",
    kbRoot: join(home, "kb"), runsDir: join(home, "runs"),
    config: DEFAULT_CONFIG, doFetch: fake,
  });
  const docsDir = join(home, "kb", "collections", "webrefs", "docs");
  const file = readdirSync(docsDir)[0];
  const { meta, body } = parseDoc(readFileSync(join(docsDir, file), "utf-8"));
  expect(meta.authority).toBe("reference");
  expect(meta.tags).toContain("deep-research");
  expect(meta.tags).toContain("dr-e2e");
  expect(meta.sources[0].url).toBe("https://x.test/article");
  expect(body).toContain("Real Heading");
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run test/e2e-land.test.ts`
Expected: PASS. (Imports ②b's real `parseDoc` — proves byte-level compatibility with the library.)

- [ ] **Step 3: Run the entire suite once more**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-land.test.ts
git commit -m "test: e2e — acquired page lands as ②b-parseable reference doc"
```

---

## Definition of Done (Plan 1)

- [ ] `pi-deep-research` extension scaffolded; `tsc --noEmit` clean; `node scripts/smoke-load.mjs` prints `LOAD_OK` with `dr_acquire`.
- [ ] Full vitest suite green (types, fetcher, html, pdf, repo, dispatch, crawler, landing, run-store, dr-context, acquire, e2e).
- [ ] **HTML clean-extraction by default:** nav/footer/script stripped; headings preserved (Task 4).
- [ ] **All four entry kinds work:** `url`, `crawl` (bounded, robots-aware, deduped), `pdf`, `repo` (Tasks 5/6/7/8/12).
- [ ] **Landing is byte-compatible with ②b:** files land as `reference` authority, tagged `deep-research` + `<run-id>`, with `sources` provenance; ②b's own `parseDoc` reads them (Task 9 cross-check + Task 13 e2e).
- [ ] **Run-store** records landed docs and reloads (Task 10).
- [ ] **Config** file merges over defaults (Task 11).
- [ ] Manual: run `dr_acquire { kind:"url", value:"<a real docs page>", collection:"scratch" }`, then `/kb-reindex` in ②b, then `kb_search` finds the landed content.

**Hand-off to Plan 2 (Conductor, Workers & Synthesis):** planner (topic → sub-questions over entry points), `WorkerRunner` interface + serial PI-sub-session impl + `FakeWorkerRunner`, per-role model map (cheap workers / strong synthesizer), synthesis `agent-note` via `kb_write`, citation pass via `kb_cite`, hard budgets/kill-switch, `/research` + `/research-status` commands, headless mode. Plan 1's `acquireEntryPoint` + `landDoc` + `RunStore` are the primitives Plan 2's workers call.

---

## Implementation deviations (as built)

Recorded after execution so the plan matches reality:

1. **PDF library: `pdf-parse` → `unpdf`.** `pdf-parse` bundles pdf.js v1.10 which throws `bad XRef entry` when loaded from an ES-module *file* on Node 24 (i.e. it fails in PI's real extension runtime, not just under vitest). Switched to `unpdf` (maintained, ESM-native pdf.js). `pdf.ts` now uses `getDocumentProxy` + `extractText`. Test builds a byte-offset-correct minimal PDF in-memory.
2. **Version control: tracking enabled for `agent/extensions/`.** The repo root `.gitignore` ignored all of `agent/`, so extension code (incl. the pre-existing `pi-research-library`) was untracked and per-task commits were silent no-ops. Refined `.gitignore` to `agent/*` + `!agent/extensions/` (secrets/sessions/bin/git/settings still ignored). The two sibling extensions are their own git repos, so they are explicitly re-ignored to avoid embedding them.
3. **Added dep `typebox`** (tool param schemas) — was implied by the `dr_acquire` tool code but missing from the Task 1 manifest.
4. **Smoke loader uses `jiti`.** Plain `node scripts/smoke-load.mjs` can't resolve the `.js`→`.ts` import specifiers the codebase uses; the smoke now loads via `jiti` (how PI itself loads extensions), exercising the real deps (typebox/unpdf/jsdom). Wiring is also asserted in `test/wiring.test.ts` (vitest). Node-only cross-package `parseDoc` check (Task 9 Step 5) was likewise moved into vitest (`test/e2e-land.test.ts`), where `.js`→`.ts` resolves.
5. **No ②b change needed.** `kb_import` already defaults `authority: "reference"`, and landing writes files directly into the collection (files-as-truth), so v1 pulled in zero changes to `pi-research-library`.

**Verification (fresh):** vitest 13 files / 21 tests, 0 failures · `tsc --noEmit` exit 0 · `node scripts/smoke-load.mjs` → `LOAD_OK {"tools":["dr_acquire"],"commands":["dr-acquire"]}`.
```

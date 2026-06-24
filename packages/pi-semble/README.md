# pi-semble

Hybrid (semantic + lexical + code-aware-rerank) search over your local code **and** the
markdown doc library, backed by [MinishLab/semble](https://github.com/MinishLab/semble).
Replaces code-vocab's `vocab_find` and pi-research-library's FTS5 `kb_search`.

No model server, no GPU. Semble is invoked on demand via `uvx` (CPU-only).

## Tools

| Tool | What it does |
|---|---|
| `repo_search(query, top_k?, snippets?)` | Semantic+lexical search over THIS repo's source. Returns `file:line` ranked chunks. |
| `kb_search(query, scope?, top_k?, snippets?)` | Search the doc library. `scope`: `project` \| `global` \| `both` (default `both`). Hides superseded docs; annotates `[authority]` + sources. |
| `find_related(file_path, line, top_k?)` | Code semantically similar to a location — siblings / callers / tests. |

> Note: the **web** code-example tool `code_search` belongs to `pi-web-tools`; this extension's
> local code tool is deliberately named `repo_search` to avoid the collision.

## Index / model layout

Three artifacts, two of them under `~/.pi/cache` (shared) and one per-project:

| Artifact | Location | Env var |
|---|---|---|
| Project index (code + project docs) | `<repo>/.pi/semble/` (git-ignored, rebuildable) | `SEMBLE_CACHE_LOCATION` |
| Global doc index (`~/.pi/kb`) | `~/.pi/cache/semble-global/` (built once, shared) | `SEMBLE_CACHE_LOCATION` |
| Embedding model (`potion-code-16M`, ~64 MB) | `~/.pi/cache/hf/` (shared, download-once) | `HF_HOME` |

The index is built lazily: a fire-and-forget warm-up runs on `session_start` (git-freshness gated),
and the first real query builds the cache if needed. **First ever session downloads ~64 MB** (the model).

## First run in a new repo

The first time pi opens in a code repo, semble **asks before indexing** — a one-time
confirm dialog ("Initialize semble?"). The answer is remembered per repo via markers
under the git-ignored `<repo>/.pi/semble/` cache dir:

| Decision | Marker | Effect |
|---|---|---|
| Yes | `.enabled` (or legacy `.warm-signal`) | Silent freshness-gated warm on every session. |
| No | `.opt-out` | Dormant: no warm, no nudges. Search tools stay callable on demand. |
| Unset | _(no cache dir)_ | Prompt again next interactive session. |

Repos indexed before this change have a `.warm-signal` and are treated as already
enabled, so they keep working with no prompt. To re-decide a declined repo, delete
`<repo>/.pi/semble/` (or its `.opt-out` marker). Without an interactive UI
(print/RPC), an `unset` repo is left untouched (no prompt, no warm) unless
`PI_SEMBLE_AUTO_INIT=1` is set.

## Behavior

- **Detection:** only activates as a code repo when source files are tracked at any depth
  (git-aware) or a manifest exists; non-code dirs index nothing.
- **Guard:** if the agent reaches for manual `grep`/`find`/`read` to discover code, it's nudged
  (once per session) toward `repo_search`/`kb_search`/`find_related`. A short system-prompt note
  also states the preference up front.
- **Provenance:** `kb_search` reads frontmatter of the returned hits to drop superseded docs and
  annotate authority/sources — semble itself is pure retrieval.
- **Fail-open:** every hook swallows errors; semble is an optimization, never a hard dependency.

## Config

| Env | Effect |
|---|---|
| `PI_SEMBLE_DISABLE=1` | Register nothing (kill switch). |
| `PI_SEMBLE_AUTO_INIT=1` | Skip the first-run prompt and index silently (restores pre-prompt behavior; useful for CI / scripted / no-UI runs). |

## Requirements

- `uv`/`uvx` on PATH (semble is pulled via `uvx --from "semble[mcp]" semble`).
- Python ≥ 3.10 (managed by uvx).

## Deferred

Warm-MCP transport (a lazily-spawned, warm semble MCP server for ~ms queries instead of the
~1.4 s per-call `uvx` startup) is a future internal swap behind the same engine interface — see
`docs/superpowers/plans/2026-06-20-semble-search-integration.md`, Phase 8.

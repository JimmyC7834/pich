# @jc4649/pi-context-collapse

Deterministic, reversible collapse of bulky tool outputs in a [pi](https://github.com/earendil-works/pi) coding-agent session, to keep the context window lean without losing information.

## What it does

On each LLM call (`context` hook), it walks the transcript newest→oldest and collapses **old, non-error** tool results that exceed a token threshold — replacing the bulky body with a compact summary plus an `expand` handle. A protected recent tail (default ~6000 tokens, `PI_COLLAPSE_PROTECT_TOKENS`) is always left untouched so the prompt prefix stays byte-stable and prompt-cache-friendly.

Collapsed originals are kept in a local SQLite cache (`node:sqlite`), so the model can call the registered `expand` tool to recover any collapsed result verbatim.

### Compressors
- **log** — strips ANSI, drops progress/step-counter noise, dedupes, caps head/tail.
- **json/paths** — structural summarization of large JSON and path lists.
- **useless** — elides empty or "no matches" search results.

## Configuration
- `PI_COLLAPSE_DIR` — artifact dir (default `<cwd>/.pi/collapse`).
- `PI_COLLAPSE_PROTECT_TOKENS` — recent-tail tokens never collapsed (default 6000).

## Install
```
pi install @jc4649/pi-context-collapse
```

MIT

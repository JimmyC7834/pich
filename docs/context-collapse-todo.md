# pi-context-collapse — improvement backlog

Ideas ported from oh-my-pi's layered tool-output reduction (`can1357/oh-my-pi`:
`docs/compaction.md`, `docs/blob-artifact-architecture.md`,
`crates/pi-shell/src/minimizer/`). See the research comparison for full context.

## Done

- **[x] Better `log` compressor (layer 1 — shell minimizer).** ANSI strip +
  common build/shell noise rules + head/tail cap, replacing dedupe-only.
  Measured on real cached logs: **21.9% → 51.2%** reduction.
  `src/compressors/log.ts`.

- **[x] Useless-result elision.** Zero-match / empty search results blank to
  `[Uneventful result elided]`. `src/compressors/useless.ts` + `classify()`
  routes it before the token gate (these results are short). Conservative:
  empty output only counts as useless for search tools (never bash), and a
  "no matches" phrase only in a short (≤4-line) result.

- **[x] Cache-aware, lazy trimming.** Collapse moved off the eager `tool_result`
  hook onto the `context` hook (fires before each LLM call). `src/prune.ts`
  walks newest→oldest, protects the recent tail (`PI_COLLAPSE_PROTECT_TOKENS`,
  default 6000), and collapses only OLDER non-error tool results. Session
  storage keeps full results; only the in-context view is trimmed. Output is
  byte-stable across calls (monotonic boundary + per-hash memo) so the provider
  prompt cache holds. Recent, in-use results are no longer touched — the cause
  of the 06-18 expand-thrash.

## Todo

- **[ ] Superseded-read elision (gap, lower priority).** When the agent reads a
  path it already read, blank the older result (keyed by path). We do NOT have
  this — `pi-hashline-edit` only returns a post-*edit* diff to avoid re-reads
  after edits, not stale-read blanking. Lower priority because edit-diff already
  kills the most common re-read trigger.

- **[ ] Tune `PI_COLLAPSE_PROTECT_TOKENS`.** Default 6000 is a guess; confirm
  against `pi-usage-recorder` cache-write telemetry once the lazy pass has run a
  few real sessions. Too low → recent results collapse and get re-expanded; too
  high → little savings.

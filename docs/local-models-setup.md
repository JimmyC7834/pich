# Local models setup

## Active model roster

| Role | Model | Local/Cloud |
|---|---|---|
| `summarize` (code) | `qwen2.5-coder:14b` | Local |
| `summarize` (prose/URL) | `qwen2.5-coder:3b` | Local |
| `compress` | `qwen2.5-coder:3b` | Local |
| `code_locate` ranking | `qwen2.5-coder:3b` | Local |
| `scout` / `worker` loops | `deepseek-v4-flash` | Cloud |
| Main orchestrator | `deepseek-v4-pro` | Cloud |

The **single-shot tools** run locally (deterministic transforms — no agentic judgment needed).
The **agentic loops** (scout/worker) run on cloud flash.

## Why the loops are on cloud flash, not a local 14B

We tested local models as the scout recon driver extensively:

- **qwen2.5-coder:14b** — emits tool calls as text, not Ollama's structured `tool_calls`
  (0/5). pi can't drive it.
- **qwen3:14b** — emits structured `tool_calls` reliably (5/5) and, once given a real context
  window (`num_ctx`, see below) and a read-only toolset, it completes safely. **But its recon
  is unreliable: it hallucinates file names, function names, and code** (e.g. invented a
  non-existent `src/executor.ts` and a fabricated `buildRipgrepArgs`). A 14B's instinct to
  fill gaps with plausible fiction makes it untrustworthy for recon the main agent depends on.

Conclusion: the agentic loop needs cloud-grade judgment. `deepseek-v4-flash` is fast (~20s),
accurate, and reliable at a small token cost. Local stays for the single-shot tools, where it
wins cleanly.

## Unused leftovers (safe to remove)

These were created/used during the experiment and nothing points at them now:

```bash
ollama rm qwen3-scout:14b   # custom num_ctx variant for the abandoned local scout
ollama rm qwen3:14b         # base, only kept for the experiment
```

(`qwen3-scout:14b` shared weights with `qwen3:14b`, so removing just the variant frees almost
nothing; remove both to reclaim ~9 GB.)

## Appendix: the `num_ctx` gotcha (if you ever drive a local model agentically)

pi does **not** set `num_ctx`, so Ollama caps a model at its default **4096** tokens — far too
small for an agentic loop (system prompt + project context + tool schemas + history), causing
silent truncation ("stops halfway"). To give a local model a real window, bake it into a
variant:

```
FROM <base-model>
PARAMETER num_ctx 24576
```
```bash
ollama create <name> -f Modelfile
```

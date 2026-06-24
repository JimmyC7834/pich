# Multi-Model Local Harness — Design

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation
**Author:** brainstormed with Claude

## Goal

Use small local models on the workstation GPU as a **context firewall** in front of
the cloud brain (DeepSeek-v4-pro), so that:

1. **DeepSeek's token consumption drops** — it never ingests raw bulk (files, logs,
   search dumps); it only ever sees distilled, relevant text.
2. **The main agent's context window stays clean** — high-volume, low-reasoning work
   (reading, searching, log triage, summarization) happens locally and off the cloud
   transcript.
3. **Overall task performance improves** — the brain spends its budget on reasoning,
   fed by precise inputs, instead of drowning in haystacks.

This is an extension of the existing `pi` harness, not a rewrite.

## Hardware constraints (design drivers)

- **GPU:** AMD Radeon RX 7800 XT, 16 GB VRAM (gfx1101).
- **CPU:** Ryzen 5 5600X, 6c/12t.
- **OS:** Windows 10.
- **Local serving:** Ollama (ROCm runtime; Vulkan fallback if a model trips ROCm kernels).

The load-bearing constraint: **16 GB cannot hold qwen2.5-coder:14b plus all specialists
hot simultaneously.** The architecture is therefore tiered into "always-hot tiny models"
plus "on-demand heavy model," and is built around that swap.

## Key design decision: no vector index (grep beats RAG here)

An earlier draft included a vector/embedding index for `code_search`. **Cut.** For a
single repo at this scale, exact-match tools (`ripgrep`, `find`, LSP) are precise,
instant, and never go stale — a local scout that greps and reads files locally keeps every
search token off the cloud *without* an index. Embeddings would add a maintenance tax
(staleness on every edit, chunking strategy, a vector-store dependency) for marginal gain.
Notably, agents like Claude Code use **no embeddings** for code — just ripgrep + a smart
agent loop.

Semantic search is therefore **out of the core design** and parked as a future option
scoped to the prose knowledge base, not code (see "Future / optional").

## Architecture overview

```
                 ┌─────────────────────────────────────────┐
                 │   DeepSeek-v4-pro  (cloud, sole brain)    │
                 │   - runs the main loop / orchestration    │
                 │   - sees ONLY distilled text              │
                 └───────────────┬───────────────────────────┘
                                 │ calls firewall tools
   ┌──────────────┬──────────────┼───────────────┬──────────────┐
   ▼              ▼              ▼               ▼              ▼
summarize     code_search     compress         scout      (sub-loops, ph.2)
(qwen14b/3b)  (ripgrep+        (3b)            (qwen14b)    (qwen14b bounded)
               local read)
```

DeepSeek is the **sole orchestrator** (the main `pi` session model). Local models are a
support layer it invokes like functions. This matches what the existing `orchestrator`
skill already mandates ("never read files directly; route through summarizer; explore via
scouts") — this design supplies the missing tools.

## Layer 0 — Local model roster & VRAM budget

| Role | Model | Residency | ~VRAM |
|---|---|---|---|
| Heavy reader / scout / sub-loop | **qwen2.5-coder:14b** (Q4_K_M) — already installed | On-demand, `keep_alive=5m` | ~9 GB + ~3 GB KV |
| Fast utility (router, log-compress, commit msgs, short summaries) | **qwen2.5-coder:3b** (Q4) | Always hot | ~2.2 GB |

**Residency strategy:** the 3b (~2.2 GB) stays resident; only the 14b swaps in/out.
**Peak VRAM** (14b loaded + 3b hot) ≈ 14.2 GB — fits 16 GB with comfortable headroom.
(No embedding model in the core roster — see the no-vector-index decision above.)

**Ollama configuration:**
- Keep-alive is set per request — `-1` (pinned) for the 3b, `5m` for the 14b.
- `OLLAMA_MAX_LOADED_MODELS=2` so the 3b and the 14b can coexist.
- Cap the 14b context (e.g. `num_ctx` 16k–32k) to keep KV cache within budget; raise only
  when a task genuinely needs to read very large files.

## Layer 1 — Firewall tools (single-shot)

Four functions. Each runs a local model once and returns **distilled text only**. These
four are the *entire* set of entry points into DeepSeek's context — nothing raw gets in
except through one of them (or the escape hatch).

1. **`summarize(path | url)`** — *exists* (`agent/extensions/summarize.ts`).
   Upgrade: route code/source files → qwen14b; prose/short text → 3b. The
   `summarizer.md` agent file remains the single source of truth for model + prompt;
   its default model is repointed from `phi3.5` to `qwen2.5-coder:14b` for code.
   Keeps existing chunked map-reduce for large inputs.

2. **`code_search(query)`** — *new, ripgrep-backed.* A thin local scout: run `ripgrep`
   for the query's terms, have the local model read the hit sites, and return the top 3–5
   matches as `file:line` + a one-line "why this matches." **No vector index, no
   embeddings, no chunking.** Replaces "read the file to find X" with a local, indexless
   search that costs the cloud nothing.

3. **`compress(tool_output)`** — *new, 3b.* Filters noisy tool output (test/build logs,
   `grep`/`ls` dumps, stack traces) down to the relevant lines + a one-line verdict before
   it ever reaches DeepSeek's context. Wraps high-volume tool results.

4. **`scout(question)`** — *exists* via `pi-subagents` (Ollama-backed scout agent).
   Local qwen14b explores (grep/read locally) and returns a findings note. `code_search`
   is the narrow, fast version of this; `scout` is the open-ended investigation version.

## Layer 2 — Targeted local sub-loops (phase 2)

For the 2–3 highest-volume task types only, let qwen14b run its *own* bounded loop and
return a single result, so DeepSeek makes far fewer round-trips:

- **"Map this feature / directory"** — local grep → read → read → synthesize → one
  architecture note.
- **"Triage these test failures"** — local read of logs + offending files → one diagnosis.

**Guardrails** (so a local loop cannot wander): max N steps, tool whitelist
(`read`/`grep`/`ls` only — no writes), token cap, wall-clock timeout. Built only *after*
Layer 1 proves out, and only where the token math justifies it.

## Layer 3 — Router (rules first)

A lightweight front-door classifier that decides each request's path **before** any
expensive model runs:

- Trivial (rename, commit message, "what does this function do") → handled locally, never
  reaches DeepSeek.
- "Where is X?" → `code_search`.
- "Summarize this file" → `summarize`.
- Hard reasoning / design / multi-file change → DeepSeek.

**Start rules-based** (pattern matching on the request). Upgrade to a tiny learned router
model only if the rules become unwieldy. This is the least essential layer — the firewall
(Layer 1) is where the savings live; the router is incremental polish.

## Cross-cutting — the escape hatch (correctness safety)

Distillation can drop a detail the brain needed. Every distilled artifact must be
**re-fetchable**: DeepSeek can demand the raw chunk/file/log on demand. Compression is the
default, never a hard wall. This is what keeps aggressive firewalling from producing wrong
answers.

## Cross-cutting — prompt engineering workstream

Each local role lives or dies by its prompt, and **small models are far more
prompt-sensitive than DeepSeek** — they need rigid, format-constrained instructions, often
with a worked example, or they ramble and silently destroy the token savings. This is a
first-class workstream, not an afterthought.

- **Pattern:** one prompt file per role as the single source of truth (the existing
  `agents/summarizer.md` convention), so prompts version and review independently of code.
- **Per role:**

  | Role | Prompt must enforce |
  |---|---|
  | `summarizer` | code mode: "exports / key types / core logic only," no preamble, no questions |
  | `compress` | "only failing/relevant lines + one-line verdict, ≤N tokens, no narration" |
  | `code_search` / `scout` | "return `file:line` + one-line why per hit, nothing else" |
  | router | not a prompt — a maintained pattern list |

- **Golden tests:** 2–3 real input fixtures per role with an expected-shape assertion, so a
  prompt regression is caught instead of silently bloating cloud context. This is part of
  the build, gated before each tool is considered "done."

## Cross-cutting — skills interaction

Custom skills and the local-model layer occupy **different layers** and stack rather than
compete:

```
SKILLS  ──────────►  DeepSeek (orchestrator)   ← skills are instructions, run HERE
                          │ calls
PROMPTS ──────────►  local tool-models          ← fixed prompts, NOT skills, run HERE
```

A skill is DeepSeek's *playbook* (how to do a review, a refactor, a research pass); the
local tools are its *hands*. The existing `orchestrator` and `pi-subagents` skills are
already this shape. Three rules keep them coexisting:

1. **Skills run on DeepSeek, never on the local tool-models.** The 3b/14b get one rigid
   prompt and do one job; they cannot reliably follow a multi-section skill. (`pi-subagents`
   already mandates: do not inject skills into spawned children.) Custom skills are thus
   unaffected by the local layer — they keep running where they always did.
2. **Custom skills should delegate bulk work to the firewall tools, not instruct direct
   reads** — "scout/summarize the test files," not "read all the test files." A writing
   convention for new skills; the `orchestrator` firewall rule enforces it as a global
   fallback.
3. **Skills cost main-context tokens — the one standing tension.** The firewall protects
   against *file/log/search* bulk; skill verbosity is a separate budget. Keep custom skills
   lean and have them *point at* the firewall tools rather than inlining long procedures.

**Precedence:** if a custom skill says "read file X directly" and the firewall says "never
read directly," the orchestrator firewall rule wins (higher-priority standing instruction).
Write skills firewall-aware from the start; careless skills still degrade gracefully because
the standing rule catches them.

## Mapping to existing pieces

| Existing | Role in this design |
|---|---|
| `agent/extensions/summarize.ts` | Layer 1 `summarize` — repoint default to qwen14b for code; add fast-model path for prose |
| `agent/extensions/filechanges/` (untracked) | Useful signal source for future kb indexing; **not** needed for the indexless core |
| `agent/extensions/pi-context-manager/` | Rolling conversation summary → keeps DeepSeek's history flat |
| `skills/orchestrator/SKILL.md` | Already enforces the firewall — update to mention `code_search`, `compress`, and sub-loops |
| `skills/pi-subagents/` (scout/worker) | Layers 1 & 2 — already Ollama-backed |

## Build order

1. **Finish the firewall** — repoint `summarize` to qwen14b; add `compress`; add the
   ripgrep-backed `code_search`; set Ollama keep-alive/concurrency/`num_ctx`; write +
   golden-test each role prompt. *(Immediate token wins, low risk, no index to maintain.)*
2. **Add sub-loops** — for the 2–3 biggest sinks, with guardrails. *(Deep savings on big
   tasks.)*
3. **Router** — rules-based front door; learned model only if needed. *(Polish.)*

## Decisions locked

- DeepSeek is the **sole orchestrator**; local models are a single-shot support layer
  (sub-loops added later, phased).
- **No vector index / RAG for code** — `code_search` is a ripgrep-backed local scout.
- VRAM: **3b hot, 14b on-demand** (not 14b pinned).
- Router: **rules-based first**; learned model only if rules get unwieldy.
- Prompt engineering (one file per role + golden tests) is a **first-class workstream**.
- Custom skills run on the orchestrator (DeepSeek), not on local tool-models; the firewall
  rule takes precedence over any skill instruction to read raw.

## Future / optional

- **Semantic search over the knowledge base** — if conceptual search over *prose* (the
  `kb/` directory, `pi-research-library`) becomes a real need, add embeddings
  (`nomic-embed-text`) + an in-process vector store (sqlite-vec/LanceDB) scoped to **docs,
  not code**. Prose is where grep is weak and embeddings actually earn their keep. The
  `filechanges` extension would feed incremental re-embeds. Revisit only on demonstrated
  need.
- **Dedicated reranker** (`bge-reranker-v2-m3`) — only relevant if/when the kb semantic
  search above exists and LLM-rerank via the 3b proves insufficient.
- **Learned router model** — only if rules get unwieldy.

## Out of scope (YAGNI)

- Vector index / RAG over the codebase (grep + local scout instead).
- vLLM / multi-GPU serving (Ollama is sufficient on this hardware).
- Replacing DeepSeek as the brain or running a local main-loop model.

## Open questions

- Which 2–3 task types justify a Layer 2 sub-loop — decide empirically once Layer 1 is
  measurable and we can see where the cloud tokens actually go.

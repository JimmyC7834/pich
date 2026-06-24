# Local Harness — Local Sub-Loops (Phase 2) Design

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation
**Author:** brainstormed with Claude
**Builds on:** Phase 1 firewall (`2026-06-14-multi-model-local-harness-design.md`)

## Goal

Let DeepSeek delegate a *whole multi-step sub-task* to a **local** model and get back a
single distilled result, so it makes far fewer round-trips. Two shapes:

1. **Recon sub-loops** (read-only) — investigate across many files / map a feature / trace
   usage / triage failures, locally, returning one findings note. The big, safe token win.
2. **Narrow mechanical edits** — a local worker performs fully-specified mechanical changes
   (rename, boilerplate, mechanical refactor) and escalates anything else to DeepSeek.

High-stakes reasoning and all non-trivial edits stay on DeepSeek. We offload the
high-volume, low-stakes work — not the judgment.

## Key decision: reuse the `subagent` tool, no new engine

Everything a "bounded sub-loop" needs already exists in the `pi-subagents` `subagent` tool
and agent-definition format. A sub-loop is simply **a `subagent` run on a local model with
bounds set**. Phase 2 is therefore *configuration + discipline*, not a new subsystem:

- We add one local agent (`worker`), add guardrail fields to the existing local `scout`,
  and write the delegation discipline into the `orchestrator` skill.
- No bespoke loop tool, no config feature.

## Key decision: guardrails live in the agent `.md` frontmatter

The agent definition (`AgentConfig`) already accepts every meaningful bound as a frontmatter
field, so the `.md` is the single source of truth (same pattern as `summarizer.md` /
`compressor.md`). **No separate config layer.**

| Guardrail | Agent `.md` field |
|---|---|
| Tool whitelist | `tools:` |
| Model | `model:` |
| Wall-clock timeout | `maxExecutionTimeMs:` |
| Token/budget cap | `maxTokens:` |
| Nesting limit (no child subagents) | `maxSubagentDepth:` |
| Model-availability fallback | `fallbackModels:` |

The only bound that is **not** a frontmatter field is `steps` (max iterations); it is set
per-invocation on the `subagent()` call and is optional. DeepSeek may pass it for an
extra-tight loop, but the `.md` is the default contract. Tuning a bound = editing the `.md`
(now git-tracked, so it versions).

## Architecture

```
DeepSeek (orchestrator, cloud)
  ├─ subagent scout  (qwen14b, READ-ONLY)  → map / trace / triage → findings note
  ├─ subagent worker (qwen14b, edits)       → mechanical edit → done | ESCALATE: <reason>
  └─ does itself: all non-trivial reasoning + all non-mechanical edits
```

## Components

### `agent/agents/worker.md` — NEW local user agent
Replaces the disabled package builtin with an intentional local one.

- `model: ollama/qwen2.5-coder:14b`
- `tools: read, grep, find, ls, edit, write` — **no `bash`** (limit blast radius)
- `maxExecutionTimeMs: 180000`
- `maxTokens: 8000`
- `maxSubagentDepth: 0` — cannot spawn children
- `systemPromptMode: replace`, `inheritProjectContext: true`, `inheritSkills: false`
- **Prompt scope:** does ONLY narrow, fully-specified mechanical edits (rename, boilerplate,
  mechanical refactor) against an explicit task/spec. If the task needs design/product/scope
  judgment, is ambiguous, or isn't clearly mechanical → makes **no edits** and returns
  `ESCALATE: <reason>`. Minimal, coherent edits only.

### `agent/agents/scout.md` — EXISTING local agent, add bounds
Already repointed to `ollama/qwen2.5-coder:14b` in earlier work. Add recon bounds:
- `maxExecutionTimeMs: 180000`
- `maxTokens: 8000`

Its tool set and body already enforce firewall recon (routes reads through `summarize`,
cites `file:line`). No behavioral change beyond the bounds.

### `skills/orchestrator/SKILL.md` — delegation policy + cleanup
- **Add** the delegation policy (below).
- **Fix dangling refs** introduced by disabling builtins:
  - Drop `researcher` — `scout` already covers local + external/web recon.
  - Point `worker` at the new local agent and its mechanical-only scope.
  - Remove the stale "Haiku" mention (inaccurate; agents are local now).

## Delegation policy (the discipline DeepSeek follows)

Delegate a whole sub-task when, and only when:

- **→ `scout`** (read-only recon): "understand X across files," "map this feature/dir,"
  "trace where Y is used," "triage these test failures." Returns a findings note; never
  edits.
- **→ `worker`** (mechanical edit): the change is **fully specified and mechanical** (rename
  symbol, add boilerplate, mechanical refactor). Otherwise DeepSeek edits directly.
- DeepSeek may pass `steps:` (scout ~6, worker ~8) for a tighter cap; timeouts/token caps
  come from the `.md`.

Do **not** delegate: design decisions, ambiguous edits, anything needing back-and-forth, or
work DeepSeek can finish in one or two direct edits.

## Error handling & escalation

- **Ambiguity:** worker makes no edits and returns `ESCALATE: <reason>`; DeepSeek takes
  over. Completion-based handoff — **no intercom mid-run** (keeps it simple).
- **Timeout / step cap hit:** the sub-loop returns whatever it has, flagged partial; DeepSeek
  decides to finish it itself or continue.
- **Model unavailable:** `fallbackModels:` (if set) covers availability; this is *not* a
  difficulty-escalation mechanism (that is the `ESCALATE:` return).

## Testing

- **Static:** `worker.md` exists and frontmatter parses (valid `tools`/`model`/bounds);
  `orchestrator` skill no longer references `researcher` or a cloud `worker`, and no longer
  says "Haiku".
- **Live (real qwen14b):**
  - Recon: delegate a real "map this dir / trace usage" task to `scout` → returns a findings
    note, performs **no writes**.
  - Mechanical: delegate a real rename to `worker` → makes the correct minimal edit.
  - Escalation: delegate an ambiguous/design task to `worker` → returns `ESCALATE:` and makes
    **no edits**.
- **E2E (pi session):** confirm DeepSeek routes "map this dir" → `scout` and "rename X→Y" →
  `worker`, with `.md` bounds applied (timeout/token cap observed; no `bash` available to
  worker).

## Out of scope (YAGNI)

- General/autonomous local implementation (we chose a *narrow* worker).
- A bespoke sub-loop extension tool (reuse `subagent`).
- A separate config feature (bounds live in the `.md`).
- A reviewer-over-local-edits loop.
- The router (Phase 3).
- New specialized map/triage agents — `scout` covers them.

## Risk to validate FIRST (blocking)

Direct Ollama testing showed `qwen2.5-coder:14b` emits a correct tool call as **plain JSON
in the message body, not in the structured `tool_calls` field.** A subagent loop only works
if pi parses the model's tool calls. **Before building the full worker, validate that a pi
`subagent` run on `ollama/qwen2.5-coder:14b` actually parses + executes its tool calls** (a
trivial read-only scout task). If pi does not parse text-emitted tool calls:
- fall back to **recon-only** (scout findings, no local edits), or
- try a local model with stronger native tool-calling, or
- have `worker` *return a diff* for DeepSeek/a deterministic applier instead of calling
  `edit` itself.

This is the first task of the implementation plan; everything else depends on it.

### RESOLUTION (2026-06-14): cloud-flash drives the loops

Validated against live Ollama: `qwen2.5-coder:14b` returns **0/5** structured `tool_calls`
(always emits the call as text), and a manual ReAct loop showed it also breaks protocol
(multi-block output, drops into prose on empty results) and has **weak multi-step recon
judgment** (wrong paths/patterns). A self-made text-tool-call loop is viable but is real
robustness engineering with a middling quality ceiling.

**Decision: run the subagent *loops* on `deepseek-v4-flash`** (reliable structured tool calls
+ better judgment, cheap), keeping their context **isolated** from the main DeepSeek session —
so the firewall benefit (clean main context, pro tokens saved) is preserved. The **local
single-shot tools** (`summarize`, `compress`, `code_locate`) still do the bulk work and are
*called from within* the flash-driven loop. Consequences:
- `scout` / `worker` models → `deepseek-v4-flash` (not local 14b).
- Plan Task 1 (local tool-call gate) is **moot** — skip it; cloud flash is reliable.
- "Local-first" applies to the high-volume single-shot work (where it works), not the agentic
  loop (where local is unreliable and the savings are marginal — flash is cheap + isolated).

## Correction (2026-06-14): drop the `maxTokens` cap

Live testing: `maxTokens` in pi-subagents is a **cumulative run budget** (trips when
`observedTokens >= maxTokens`), not a per-response output cap. The `8000` value killed scout
mid-recon (a multi-step loop re-accumulates context each turn). The package's own builtin
agents set no token cap. **Removed `maxTokens` from `scout.md` and `worker.md`;** the runaway
guard is now `maxExecutionTimeMs: 180000` (3-min wall clock) plus optional per-call `steps`.
When a subagent does hit a limit and fails, the main agent tends to fall back to doing the
work itself (firewall bypass) — another reason not to set the cap too low.

## Open questions

- Whether 3 minutes (`maxExecutionTimeMs`) is the right wall-clock ceiling for heavy recon —
  tune empirically; it's a one-line `.md` edit. A token ceiling can be re-added generously
  (e.g. `false`/none, or ≥100k) if runaway cost becomes a concern.

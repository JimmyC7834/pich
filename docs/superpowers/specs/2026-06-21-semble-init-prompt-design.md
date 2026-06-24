# pi-semble: ask before initializing in a new pwd

**Date:** 2026-06-21
**Status:** Approved
**Component:** `agent/extensions/pi-semble`

## Problem

Today `pi-semble` silently builds (warms) its local code/doc search index on every
`session_start` for any code repo, gated only by git freshness. The first warm in a
repo triggers a ~64 MB model download and CPU-bound indexing with no user consent.
We want pi-semble to **ask the user whether to initialize** the first time pi is opened
in a repo it has not handled before, and to remember that answer.

## Goals

- Prompt once per repo, the first time pi opens there, before doing any index work.
- Remember the answer so the user is not nagged on later sessions.
- Preserve today's silent, freshness-gated warm for repos already initialized
  (including repos indexed before this change).
- Stay fail-open: semble remains an optimization, never a hard dependency.

## Non-goals

- No new UI surface beyond a single confirm dialog.
- No per-tool or per-query consent — the decision is per repo, once.
- No migration tooling; legacy repos are detected implicitly (see below).

## State model

Each code repo resolves to one of three states, keyed off the existing git-ignored
cache dir `<repo>/.pi/semble/`:

| State | Detected by | Behavior |
|---|---|---|
| `unset` | No `.pi/semble/` folder, or folder has neither marker below | Prompt the user |
| `enabled` | `.pi/semble/.enabled` marker present, **or** legacy `.warm-signal` present | Silent freshness warm (today's behavior) |
| `disabled` | `.pi/semble/.opt-out` marker present | Dormant — no warm, no nudges |

Legacy repos already indexed before this change have a `.warm-signal` but no
`.enabled` marker; they are treated as `enabled`, so no prompt and no behavior change.

Markers are tiny files written under the existing cache dir (already git-ignored via
the `.gitignore` the extension writes there).

New code:
- `src/paths.ts`: `enabledMarker(root)`, `optOutMarker(root)` path helpers.
- A `sembleDecision(root): "unset" | "enabled" | "disabled"` reader and
  `setSembleDecision(root, "enabled" | "disabled")` writer (location TBD between
  `paths.ts` and `index.ts`; resolved during implementation).

## Behavior

### session_start hook

```
detect targets
if not a code repo: skip (global-KB-only logic, see below)
decision = sembleDecision(repoRoot)
if PI_SEMBLE_AUTO_INIT and decision == unset: decision = enabled (persist .enabled)
switch decision:
  unset:
    if ctx.hasUI:
      yes = ctx.ui.confirm("Initialize semble?",
            "Build a local code/doc search index for this project? First run downloads a ~64 MB model.")
      if yes: write .enabled; run warm
      else:   write .opt-out
    else:
      skip; write no marker  (a later interactive session can still ask)
  enabled:
    run warm   (existing freshness-gated fire-and-forget)
  disabled:
    skip
```

The "run warm" path is the existing logic: re-arm the discovery guard, compute the
freshness signal, fire-and-forget `sembleSearch("warm", …)` for code / project KB /
global KB when stale, then persist `.warm-signal` + `.gitignore`.

### Gating the nudges

The other two hooks only act when `decision == "enabled"`:

- `before_agent_start` system-prompt note ("prefer repo_search over grep/find/read").
- `tool_call` manual-discovery guard (blocks manual grep/find, teaches semble tools).

When `disabled` (or `unset`, e.g. a no-UI session that was never prompted), both are
skipped so a declined repo stays fully dormant. The search tools remain registered and
callable on demand; calling one still builds the index lazily (explicit user/agent
action, which is acceptable).

### Global KB

The global doc index (`~/.pi/kb` → `~/.pi/cache/semble-global/`) warm is part of the
"run warm" path and therefore follows the same per-repo decision. Declining a repo
means no semble work — including global KB — for that session. This keeps a single,
predictable mental model; a power user who always wants indexing uses
`PI_SEMBLE_AUTO_INIT=1`.

## Config

| Env | Effect |
|---|---|
| `PI_SEMBLE_DISABLE=1` | Register nothing (existing kill switch, unchanged). |
| `PI_SEMBLE_AUTO_INIT=1` | Treat `unset` as `enabled`: skip the prompt and build silently. Restores pre-change behavior for CI / scripted / no-UI setups. |

To re-enable a declined repo, delete `<repo>/.pi/semble/` (or its `.opt-out` marker);
the next session treats the repo as `unset` and prompts again.

## Error handling

Every hook keeps its existing `try/catch` fail-open wrapper. A failed `confirm`,
marker write, or warm must never block session start. If the confirm rejects/throws,
treat as no decision: do not persist, do not warm (re-asks next session).

## Testing

- `sembleDecision` unit tests: unset (no dir), enabled (.enabled), enabled (legacy
  .warm-signal), disabled (.opt-out), precedence (.opt-out wins over .enabled).
- session_start wiring: unset+UI+yes → .enabled written + warm invoked; unset+UI+no →
  .opt-out written + warm not invoked; unset+no-UI → no marker, no warm;
  enabled → warm invoked, no prompt; disabled → nothing; AUTO_INIT bypasses prompt.
- Nudge gating: before_agent_start note and tool_call guard suppressed unless enabled.

Existing tests (`test/detect.test.ts`, `engine`, `e2e`) must continue to pass.

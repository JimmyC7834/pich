# Lightweight tmux Subagent System — Design

**Date:** 2026-06-19
**Status:** Research / design, pre-implementation
**Author:** researched with Claude, using `pi-subagents` as reference

## Goal

Build a **lightweight, code-minimal subagent system** that runs multiple `pi`
(or any CLI agent) instances in parallel, using **tmux as the supervisor**
instead of a bespoke process-management framework. The target is the ~80% case
that today pulls in the full `pi-subagents` extension:

> "Fan a task out to N agents, run them in parallel, watch them work, collect
> their results."

Design priorities, in order:

1. **Near-zero code.** A ~50-line bash orchestrator + the `pi` CLI + tmux. No
   build step, no Node extension, no framework.
2. **Live observability.** A human can `tmux attach` and watch every agent
   reason in real time — the feature a headless `spawn()` can't give you.
3. **Persistence.** Detached tmux sessions survive terminal/SSH drops; runs
   continue in the background and can be reattached.
4. **Agent-agnostic.** Works with any CLI agent (`pi`, `claude`, `aider`), not
   just `pi`.
5. **Robust result collection** without scraping terminal escape codes.

**In scope, lightweight variants** (see dedicated sections below): **scraped
live output** (streaming transcript + structured events, not just the final
result) and **sub-sub-agents** (recursion / nesting to arbitrary depth).

Explicitly **out of scope** (use `pi-subagents` if you need these): the
*hardened* versions of nesting — capability-token routing and sandboxed
event sinks; JSON-Schema-validated structured output with retry; acceptance
criteria / self-review; model fallback chains; TUI clarification dialogs.
The tmux versions of nesting and scraping are convention-and-file based, not
security-enforced.

## Environment caveat

tmux is Linux/macOS only (or WSL/Cygwin/MSYS on Windows). On the Windows-10
workstation this is developed from, tmux is **not** in the native Git Bash
shell — this system is intended to run under **WSL/Linux/macOS**. The
orchestrator should be developed against mockable `pi`/`tmux` shims so it stays
testable on Windows.

## Reference: how `pi-subagents` works

Read from `agent/npm/node_modules/pi-subagents` (~80 source files). Stripped to
essentials:

- **A subagent is a headless `pi` child process.** `runs/foreground/execution.ts`
  calls `spawn(getPiSpawnCommand(...))`; `runs/shared/pi-args.ts` builds the
  argv: `--session <file>`, `--model <id:thinking>`, `--tools a,b,c`,
  `--extension <path>`, `--no-skills`, `--append-system-prompt <tmpfile>`, and
  the task as a positional `Task: …` (or `@taskfile` when the task exceeds an
  8 KB arg limit).
- **Coordination is files + environment variables.** Results return via a
  **structured-output file** (`PI_SUBAGENT_STRUCTURED_OUTPUT_*` env points at an
  `output.json`, validated against a JSON Schema), plus session transcripts and
  JSONL event streams. Parent/child wiring (nesting, event sink, control inbox,
  capability token, run-id, depth, path) is threaded through `PI_SUBAGENT_*`
  env vars.
- **Two execution modes:** foreground (spawn + await exit) and background
  (`runs/background/async-job-tracker.ts` + `result-watcher.ts` poll result
  files; detached jobs survive the parent).
- **Plus heavy machinery:** acceptance criteria + self-review
  (`runs/shared/acceptance*.ts`), model fallback, chains, dynamic fanout,
  `git worktree` isolation (`runs/shared/worktree.ts`), intercom bridge, TUI
  clarification.

**The insight:** the core is just *"spawn `pi` headless, pass a task, harvest a
result file."* Everything else is orchestration polish. tmux supplies the
orchestration (parallelism, lifecycle, observability) so the lightweight system
writes almost no code.

## The `pi` CLI primitives this relies on

Confirmed from `pi --help`:

- `--print, -p` — **non-interactive**: process the prompt and exit (the headless
  one-shot mode; no TUI).
- `--mode <text|json|rpc>` — output mode. **`text`** streams human-readable
  tokens; **`json`** emits a single final machine-readable blob; **`rpc`** emits
  **JSONL events over stdio** (one JSON object per line: thinking, tool_call,
  tool_result, message, …). `rpc` is the key to *scraping* — the same stream is
  both the live transcript and the final result (see "Scraped output").
- `--model <pattern[:thinking]>`, `--tools/-t`, `--no-tools/-nt`,
  `--exclude-tools/-xt`, `--extension/-e`, `--no-extensions/-ne`.
- `--no-session` (ephemeral) or `--session-dir <dir>` + `--name <n>` (replayable
  transcripts).
- Positional prompt(s): `pi "prompt1" "prompt2"`.

## tmux primitives that matter

| Primitive | Role in the subagent system |
|---|---|
| `tmux new-session -d -s S` | Detached supervisor session (survives terminal close) |
| `tmux new-window -d -t S -n aN 'cmd'` | One agent per window (or `split-window` for a watchable grid) |
| `tmux new-window -c <dir>` | Start the agent in an isolated cwd / worktree |
| `tmux set -w remain-on-exit on` | Keep a pane alive after its process exits, to read final output + exit code |
| `#{pane_dead}` / `#{pane_dead_status}` | Poll completion and read the exit code via `display-message -p` |
| `tmux capture-pane -p -t aN` | Scrape live/scrollback output (debug / progress only) |
| `tmux pipe-pane -o 'cat >>log'` | Continuously stream a pane's output to a file |
| `tmux wait-for -S chan` / `wait-for chan` | Signal/await latch — agent signals done, supervisor blocks |
| `tmux kill-window -t S:aN` / `send-keys C-c` | Cancellation |
| `tmux attach -t S` | **Human watches all agents think, live** — the headline capability |

## Architecture

**Do not scrape the TUI.** Run `pi --print` (one-shot; exits on completion) and
redirect its `--mode json` output to a file. tmux then acts purely as the
*supervisor + observability layer*, and result collection is just reading files —
robust, with no terminal-escape parsing.

```
orchestrator.sh (bash)
   │  RUN=$(mktemp -d); tmux new-session -d -s agents
   │  for each task i (respecting a concurrency cap):
   │     tmux new-window -d -t agents -n "a$i" \
   │       "pi --print --mode json --no-session \
   │            --model $MODEL --tools read,grep,edit \
   │            $(printf '%q' "$task") >$RUN/$i.json 2>$RUN/$i.err; \
   │        echo \$? >$RUN/$i.code"
   │  wait until all $RUN/*.code exist   (or use tmux wait-for)
   │  aggregate $RUN/*.json
   ▼
results/  ← N JSON files, one per agent (--mode json = machine-readable)
```

### Reference orchestrator

```bash
#!/usr/bin/env bash
set -euo pipefail
S=agents; RUN=$(mktemp -d); MODEL=${MODEL:-sonnet}; MAX=${MAX:-4}
tmux new-session -d -s "$S" 2>/dev/null || true

spawn() { # $1=id  $2=task
  tmux new-window -d -t "$S" -n "a$1" \
    "pi --print --mode json --no-session --model $MODEL --tools read,grep,bash \
        $(printf '%q' "$2") >'$RUN/$1.json' 2>'$RUN/$1.err'; echo \$? >'$RUN/$1.code'"
}

running() { tmux list-windows -t "$S" -F '#{window_name}' | grep -c '^a' || true; }

i=0
while IFS= read -r task; do
  while [ "$(running)" -ge "$MAX" ]; do sleep 0.5; done   # concurrency cap
  spawn "$i" "$task"; i=$((i+1))
done < tasks.txt

while [ "$(ls "$RUN"/*.code 2>/dev/null | wc -l)" -lt "$i" ]; do sleep 0.5; done  # wait

for c in "$RUN"/*.code; do n=$(basename "$c" .code)
  printf 'agent %s exit=%s\n' "$n" "$(cat "$c")"
  jq -r '.result // .text // "(no result field)"' "$RUN/$n.json" 2>/dev/null || cat "$RUN/$n.err"
done
echo "Watch live anytime: tmux attach -t $S"
```

## Completion & coordination patterns

Pick per need:

1. **Exit-code sentinel file** (used above) — simplest and most robust.
   `echo $? >id.code` after the agent command; poll for the file. Fully
   decoupled from tmux internals.
2. **`tmux wait-for`** — `pi … ; tmux wait-for -S done$i` in the window; the
   supervisor runs `for i; do tmux wait-for done$i; done`. Elegant, no polling,
   one latch per agent.
3. **`remain-on-exit` + poll `#{pane_dead_status}`** — keeps the pane for
   post-mortem inspection; `tmux display-message -p -t a$i '#{pane_dead} #{pane_dead_status}'`.
   Best when you want to *attach and inspect* a finished agent.
4. **`pipe-pane` to per-agent logs** — for a live progress dashboard / streaming
   "thinking" feed without `--print` buffering.

**Isolation for file-editing agents:** give each its own `git worktree`
(mirrors `pi-subagents`' `worktree.ts`) and set the window's start dir with
`tmux new-window -c "$WORKTREE"`. Agents then cannot clobber one another.

## Scraped output (live transcript + structured events)

The base flow (`pi --print --mode json > file`) buffers and yields only the
final result. To **also** observe an agent's intermediate work — thinking, tool
calls, partial output — keep the stream and capture it. Three layers, cheapest
first:

1. **`--mode rpc` → a JSONL file (recommended).** Redirect the event stream to
   one file per agent; it is simultaneously the **live scrape** and the
   **final result** (the terminal event):

   ```bash
   pi --print --mode rpc --model "$M" --tools read,grep,edit \
      "$(printf '%q' "$task")" >"$RUN/$id.jsonl" 2>"$RUN/$id.err"
   echo $? >"$RUN/$id.code"
   ```

   Monitor or post-process by parsing events:

   ```bash
   tail -f "$RUN/$id.jsonl" | jq -rc 'select(.type=="tool_call") | .name'   # live
   jq -rs 'map(select(.type=="message")) | last | .text' "$RUN/$id.jsonl"   # result
   ```

   A **parent agent can read a child's `.jsonl` mid-flight** to monitor or steer
   it — the file is the scrape channel.

2. **`tee` to keep it visible in the pane** so `tmux attach` shows the stream
   live while it is also saved:

   ```bash
   pi --print --mode rpc … "$task" | tee "$RUN/$id.jsonl"
   ```

3. **tmux-level capture** when the agent draws a TUI (raw bytes, escape codes):
   - `tmux capture-pane -p -t a$id` — on-demand snapshot of the rendered pane.
   - `tmux pipe-pane -o -t a$id 'cat >>"$RUN/$id.raw"'` — continuous raw capture.

   Prefer layer 1 for anything machine-consumed; reserve layer 3 for human
   debugging or agents without a `--mode rpc` equivalent.

**Rule of thumb:** the *scrape* is a file (`.jsonl`), not the terminal. tmux
`attach` is for humans to watch; files are for agents/orchestrator to read.

## Sub-sub-agents (recursion / nesting)

Recursion stays lightweight if you make spawning a **reentrant `subagents`
command** rather than a top-level-only script: given tasks, it spawns tmux
windows, waits, and prints aggregated results to **stdout**. Any agent that has
the `bash` tool and this command on `PATH` can then fan out — including agents
that are themselves children. Nesting composes for free.

### Shared coordination state (via env)

The whole tree shares one tmux session and one run dir, propagated to every
child through the environment:

```bash
export AGENTS_SESSION=${AGENTS_SESSION:-agents}   # one tmux session for the whole tree
export AGENTS_RUN=${AGENTS_RUN:-$(mktemp -d)}     # shared result dir
export AGENT_DEPTH=${AGENT_DEPTH:-0}              # this agent's depth
export AGENT_ID=${AGENT_ID:-root}                 # hierarchical id, e.g. 0.1.2
export MAX_DEPTH=${MAX_DEPTH:-3}
export MAX_TOTAL=${MAX_TOTAL:-12}                 # global live-agent cap (whole tree)
```

### Hierarchical ids

Child ids extend the parent's: root spawns `0,1,2`; agent `0` spawns `0.0,0.1`;
and so on. The window name mirrors the id (`a0`, `a0.1`, `a0.1.2`), so a single
`tmux attach -t "$AGENTS_SESSION"` shows the **entire recursion tree** as a flat
list of named windows, and `"$AGENTS_RUN/<id>.jsonl"` reconstructs parent→child.

### The reentrant helper (sketch)

```bash
subagents() {  # each positional arg is one child task; prints aggregated results
  [ "$AGENT_DEPTH" -ge "$MAX_DEPTH" ] && { echo "refused: MAX_DEPTH" >&2; return 2; }
  local i=0 ids=()
  for task in "$@"; do
    # global fork-bomb guard: never exceed MAX_TOTAL live windows tree-wide
    while [ "$(tmux list-windows -t "$AGENTS_SESSION" -F x 2>/dev/null | wc -l)" -ge "$MAX_TOTAL" ]; do
      sleep 0.3
    done
    local cid="${AGENT_ID}.${i}"
    tmux new-window -d -t "$AGENTS_SESSION" -n "a$cid" \
      "AGENT_DEPTH=$((AGENT_DEPTH+1)) AGENT_ID='$cid' \
       pi --print --mode rpc --tools read,grep,edit,bash \
          $(printf '%q' "$task") >'$AGENTS_RUN/$cid.jsonl' 2>'$AGENTS_RUN/$cid.err'; \
       echo \$? >'$AGENTS_RUN/$cid.code'"
    ids+=("$cid"); i=$((i+1))
  done
  for cid in "${ids[@]}"; do                       # block on this level's children
    while [ ! -f "$AGENTS_RUN/$cid.code" ]; do sleep 0.3; done
    echo "### child $cid (exit $(cat "$AGENTS_RUN/$cid.code"))"
    jq -rs 'map(select(.type=="message")) | last | .text' "$AGENTS_RUN/$cid.jsonl" 2>/dev/null \
      || cat "$AGENTS_RUN/$cid.err"
  done
}
```

Because each child is spawned with `--tools …,bash` and inherits `AGENTS_*` +
`AGENT_DEPTH`, **it can call `subagents` itself** — that is the sub-sub-agent.
The parent reads its children's results as the command's stdout; the
grandparent reads the parent's; recursion is just function call → file → read.

### Recursion safety (the part you cannot skip)

Unbounded recursive spawning is a fork bomb. Two guards are mandatory, both
shown above:

- **`MAX_DEPTH`** — `subagents` refuses past a depth, propagated via
  `AGENT_DEPTH`. Stops infinite descent.
- **`MAX_TOTAL`** — a *global* cap on live windows across the whole tree (not
  per-parent), enforced by counting `tmux list-windows`. Stops N×M explosion.
  For correctness under concurrent spawners, wrap the count-and-spawn in a
  `flock` on a lockfile in `$AGENTS_RUN` so two agents don't both pass the cap.

Optional: a **per-task timeout** (`timeout 600 pi …`) so a stuck grandchild
can't pin a window slot forever, and a wall-clock budget on the whole tree.

## Trade-offs vs. `pi-subagents`

**Gained**

- **Near-zero code** — ~50 lines of bash, no build, no Node, no extension.
- **Live human observability** — `tmux attach` to watch agents reason in real
  time; reattach after a disconnect.
- **Persistence** — detached session survives terminal/SSH drops; background
  runs come for free.
- **Agent-agnostic** — any CLI agent, not just `pi`.
- **Trivial parallelism + isolation** — one window/pane each, own cwd/worktree.

**Supported, but as convention not guarantee**

- **Scraped output** — via `--mode rpc` JSONL files (live transcript + result),
  but *unvalidated*: no schema enforcement / retry like `structured-output.ts`.
- **Sub-sub-agents** — via the reentrant `subagents` helper + `AGENTS_*` env,
  but *unhardened*: depth/total are convention-enforced (`MAX_DEPTH`/`MAX_TOTAL`
  + `flock`), with none of `pi-subagents`' capability-token routing or sandboxed
  event sinks. Fine within a trusted tree; not a security boundary.

**Given up (hand-rolled, lightly, if needed)**

- **Acceptance criteria, self-review, model fallback, chains** — all bespoke.
- **Programmatic aggregation** — you parse result files yourself (`jq`), vs.
  structured return values.
- **Backpressure** — you add the concurrency caps (`MAX`, plus `MAX_TOTAL` for
  the recursive case).

## Recommendation

For a *lightweight* system that still scrapes and nests, the sweet spot is:

- **`pi --print --mode rpc`** one-shot per task → a `.jsonl` file that is both
  the **live scrape** and the **final result**,
- **one tmux window per agent** (hierarchical names `a0.1.2` for the tree),
- **exit-code sentinel files** for completion; `jq` over the `.jsonl` for results,
- a **reentrant `subagents` bash command** so any agent with `bash` can recurse,
  with **`MAX_DEPTH` + `MAX_TOTAL` + `flock`** guarding against fork bombs,
- **`AGENTS_SESSION`/`AGENTS_RUN`/`AGENT_DEPTH`/`AGENT_ID`** env shared down the tree,
- **`git worktree` isolation** for mutating agents,
- `tmux attach` for live human oversight of the whole tree.

Reach for `pi-subagents` only when you need its *guarantees* — schema-validated
structured output with retry, capability-token-secured nesting, acceptance/
self-review, or model-fallback chains — rather than convention-based scrape and
recursion.

## Proposed implementation plan

1. `scripts/tmux-agents.sh` — exposes a reentrant **`subagents`** function
   (spawn → wait → aggregate) plus a top-level CLI. Flags/env: `--model`,
   `--tools`, `--worktree`, `--tasks <file>`, `MAX`, `MAX_DEPTH`, `MAX_TOTAL`.
2. **Scrape layer** — agents run `--mode rpc` to `$AGENTS_RUN/<id>.jsonl`; a
   `result()` helper extracts the final message and an `events()` helper tails
   for live monitoring. The same file serves humans (`tmux attach`) and agents
   (`jq` over the jsonl).
3. **Recursion guards** — `AGENT_DEPTH`/`MAX_DEPTH` refusal + a `flock`-protected
   global `MAX_TOTAL` window cap; optional per-task `timeout` and a tree-wide
   wall-clock budget.
4. **Testability on Windows:** develop against `PI_BIN`/`TMUX_BIN` overrides so a
   mock `pi` (emits canned JSONL + exit code) and a mock `tmux` (or a thin
   real-tmux harness under WSL) drive the test suite. TDD the pure pieces (id
   derivation, depth/total guards, jsonl→result extraction, aggregation).
5. **Worktree mode** — `--worktree` creates `git worktree add` per agent and
   tears it down (or keeps it for inspection) on completion.
6. **Cancellation** — a `--cancel <session>` path that kills windows (whole
   subtree by id prefix) and reaps sentinels.

## Open questions

- **Result schema:** standardize on `pi --mode json`'s shape, or wrap agents to
  emit a known envelope (`{ id, exit, result, error }`)?
- **Failure policy:** retry a failed agent (exit ≠ 0) in-orchestrator, or surface
  and let the caller decide? (`pi-subagents` retries with model fallback.)
- **Nested fanout defaults:** what `MAX_DEPTH` / `MAX_TOTAL` ship as safe
  defaults (3 / 12 proposed)? Should depth > 1 require an explicit opt-in flag,
  given the fork-bomb risk?
- **Scrape verbosity:** is the full `--mode rpc` event stream the right scrape
  granularity, or should a parent see a filtered view (tool calls + final only)
  to keep its own context small when monitoring children?
- **Cleanup:** auto-`kill-session` on success vs. leave it for `attach`-based
  inspection (with `remain-on-exit`)?
```

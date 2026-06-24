# pi-ralph — Ralph kanban for pi

Runs a Ralph loop over a SQLite-backed kanban: the agent works tasks one at a
time, compacting context between iterations once it grows large, until the board
is empty.

## Use
- `/ralph-add <project> :: <title> :: <spec>` — add a task (human).
- `ralph_add` tool — add a task (AI).
- `/ralph <project>` — view the board + recent progress (read-only).
- `/ralph-run <project> [--once] [--max N]` — start a run (`--once` = one task, human-in-loop).
- `/ralph-note <project> <text>` — append a human note.

## How it works
A run sets `RunState.active`; `before_agent_start` re-injects the protocol + live
board each turn (survives compaction — state is in SQLite). `ralph_complete` arms
`pendingContinue`; the `turn_end` driver injects the next iteration (or stops on
empty board / `--max` / `--once`), compacting first **only when context usage is
at or above the threshold** — cheap iterations skip the compaction round-trip.
Usage that can't be read yet (e.g. right after a prior compaction) compacts to
stay safe.

## Notes
- DB: `<cwd>/.pi/ralph/ralph.db` (override with `RALPH_DB`; `:memory:` in tests).
- Compaction threshold: `RALPH_COMPACT_PCT` (% of context window, default `15`).
- Done-gate is **soft**: the agent self-reports. Keep tasks small, give each a
  `verify` command, and keep CI green — that's the real safety net.

## Dev
`npm install && npx vitest run` · `npx tsc --noEmit` (typecheck).

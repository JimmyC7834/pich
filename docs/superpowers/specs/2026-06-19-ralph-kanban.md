# Spec — Ralph Kanban (pi-ralph extension)

Date: 2026-06-19
Status: scoped (not yet implemented)

## 1. What this is

A pi extension that runs a **Ralph loop over a kanban backlog**: a durable list of
tasks (each a small spec / mini-PRD) that an AI works through one at a time,
resetting context between tasks, until the board is empty. Humans and the AI both
add/curate tasks; a read-only pi TUI shows the board + progress.

Inspiration: Geoff Huntley's Ralph + HumanLayer RPI + Anthropic "effective
harnesses for long-running agents" (JSON-PRD + append-only progress + feedback
loops). This is the file-based-Ralph idea, re-homed into pi with SQLite + tools +
a UI instead of `ralph.sh` + `prd.json` + `progress.txt`.

## 2. Decisions (locked)

| Axis | Choice | Implication |
|------|--------|-------------|
| Loop driver | **In-session** (pi extension drives the loop in one session) | Context reset via compaction + follow-up injection, not a fresh process per task |
| Storage | **SQLite** (`better-sqlite3`, as pi-capability-index does) | Structured queries by project/status/deps; not git-diffable (a file mirror is a future enhancement) |
| UI | **Read-only board** | View todo/doing/done + progress; all mutation via tools/commands |
| Tools | **AI + human** add/interact | One data layer, two front doors (tool calls + slash commands) |
| Done-gate | **Soft** | AI self-reports done; correctness leans on its own `verify` run + out-of-band CI. Hard gate is a future enhancement |
| Compaction | **After every task** | Deterministic context reset per iteration; simpler than threshold-based tuning |
| Board | **Read-only, non-interactive** | Tasks added via `ralph_add` tool (LLM) / `/ralph-add` (human); never edited in the TUI |

### Non-goals (v1)
- No multi-agent fan-out / parallel workers (one task at a time, by design — avoids
  the merge-conflict hell the Ralph video calls out).
- No hard verification gate (runner does not block "done" on a failing check).
- No external fresh-`pi`-per-task process model.
- No interactive editing inside the TUI.

## 3. Architecture — the in-session loop

pi sessions are turn-based, so "loop" = the agent keeps taking the next task,
with the extension stitching iterations together and resetting context between
them. Both stitching mechanisms already exist in sibling extensions:

- **Follow-up injection** — `pi.sendUserMessage(text, { deliverAs: "followUp" })`
  (used by `code-vocab-wire.ts`; `deepseek-compact.ts` injects a resume turn after
  auto-compaction). After a task completes we inject "continue with the next task."
- **Compaction** — `deepseek-compact.ts` already triggers compaction at a threshold
  and resumes. We reset context **between tasks** so each task starts near the
  "smart zone."
- **Per-turn re-injection** — `before_agent_start` re-injects the live board from
  SQLite every turn (same mechanism `code-vocab-wire` uses for the atlas), so the
  board survives compaction; the conversation doesn't have to "remember" it.

### Iteration lifecycle
```
/ralph-run <project>           # human starts a run (or --once for human-in-loop)
  └─ inject run-kickoff prompt
     loop (bounded by maxIterations backstop):
       1. agent calls ralph_next        → highest-priority unblocked todo task
       2. agent calls ralph_claim(id)   → status: todo → doing
       3. agent implements; if task.verify present, runs it (soft)
       4. agent calls ralph_complete(id, summary)
            → status: doing → done
            → append summary to progress log
            → (extension) git-commit hint, compact (ALWAYS, after each task), inject continuation
       5. fresh-ish context; board re-injected; back to 1
     until ralph_next returns nothing → agent outputs "PROMISE COMPLETE" → stop + notify
```
Backstop: extension counts completed/injected iterations; stops at `maxIterations`
even if the agent never declares done. Mirrors the video's max-iter arg.

Human-in-the-loop (`--once`): run a single iteration, no continuation injection —
the steering/learning mode (≈ `ralph-once.sh`).

## 4. Data model (SQLite)

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,        -- slug
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  active_run  INTEGER NOT NULL DEFAULT 0  -- 1 while a run is in progress
);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,        -- slug, unique within project
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,           -- durable WHAT: behavior + acceptance criteria
  prd         TEXT,                    -- optional just-in-time HOW (disposable); usually agent-filled
  priority    INTEGER NOT NULL DEFAULT 0,  -- higher = sooner
  status      TEXT NOT NULL DEFAULT 'todo', -- todo | doing | done
  depends_on  TEXT NOT NULL DEFAULT '[]',   -- JSON array of task ids
  verify      TEXT,                    -- optional shell command the AI should run before done (soft)
  created_by  TEXT NOT NULL,           -- 'human' | 'ai'
  created_at  TEXT NOT NULL,
  done_at     TEXT
);

CREATE TABLE progress (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  task_id     TEXT,                    -- nullable (project-level note)
  ts          TEXT NOT NULL,
  author      TEXT NOT NULL,           -- 'human' | 'ai'
  text        TEXT NOT NULL            -- append-only; the "project note" / sprint memory
);
```
DB lives at `<root>/.pi/ralph/ralph.db` (gitignored, like other `.pi/` artifacts).
`spec` vs `prd` keeps the RPI distinction: spec is durable acceptance criteria;
prd is the disposable per-task plan, regenerated rather than hand-maintained.

`ralph_next` selection = `status='todo'` AND every id in `depends_on` is `done`,
ordered by `priority DESC, created_at ASC`, limit 1.

## 5. Tools (AI-facing; humans reach the same data via §6 commands)

Registered like the other extensions (`pi.registerTool`, typebox params).

| Tool | Params | Effect / returns |
|------|--------|------------------|
| `ralph_add` | project, title, spec, prd?, priority?, depends_on?, verify? | Insert task (`created_by='ai'`). Returns id. |
| `ralph_list` | project, status? | Board: tasks grouped todo/doing/done (priority-ordered, blocked flagged). |
| `ralph_next` | project | The single highest-priority **unblocked** todo task, or null. |
| `ralph_claim` | id | todo → doing. |
| `ralph_complete` | id, summary | doing → done; append `summary` to progress; arm continuation. |
| `ralph_progress` | project, text, task_id? | Append a free-text note (sprint memory). Append-only. |

Notes:
- `ralph_complete` is the loop's heartbeat: it both records done **and** triggers the
  extension's compaction + continuation injection (§3).
- Soft gate: nothing forces `verify` to pass; the protocol prompt instructs the AI to
  run it. The field exists now so the hard-gate enhancement is a small change later.

## 6. Human entry points (commands)

- `/ralph [project]` — open the **read-only board** (§7).
- `/ralph-add` — add a task (prompt-template form: project, title, spec, priority,
  optional verify). Writes via the same data layer with `created_by='human'`.
- `/ralph-run <project> [--once] [--max N]` — start a run (or one iteration).
- `/ralph-note <project> <text>` — append a human note to the progress log.

## 7. pi UI — read-only board

A `/ralph` TUI view (pi TUI API; model on `capability-browser`):
```
 project: payments                          run: idle      4 todo · 1 doing · 7 done
 ┌ TODO ───────────┐ ┌ DOING ──────────┐ ┌ DONE ───────────┐
 │ ‹p3› refund-idmp │ │ ‹p5› beats-ui   │ │ login-rate-lim  │
 │ ‹p2› webhook-rtr │ │                 │ │ delete-confirm  │
 │ ‹p1› csv-export  │ │                 │ │ …               │
 │  ⛔ needs refund-core                                    │
 └──────────────────┘ └─────────────────┘ └─────────────────┘
 progress (last 6):
  · 21:14 ai  beats-ui: added BeatIndicator, types+tests green
  · 20:58 ai  refund-core: idempotency key on PaymentIntent …
```
Read-only and non-interactive: shows board + recent progress, refreshes from
SQLite. Blocked tasks marked (⛔ + unmet dep). No add/edit in the board — tasks
come in via the `ralph_add` tool (LLM) or `/ralph-add` (human). If a registered
TUI view is more than v1 warrants, `/ralph` may simply render the same board +
progress to chat; either is acceptable.

## 8. Prompts to inject

Four injected pieces:

**A. Protocol block** — `before_agent_start`, only while a run is active for the cwd
project. Compact (~12 lines), re-injected every turn so it survives compaction:
```
## Ralph kanban — active run: <project>
Work the backlog ONE task at a time:
1. ralph_next → highest-priority unblocked task. Work ONLY that task.
2. If it has a `verify` command, run it and make it pass before completing.
3. ralph_complete(id, summary): marks done + logs your summary.
4. ralph_progress: leave a note for the next iteration.
5. git commit this one task's work.
6. Continue to the next task. If ralph_next returns nothing, output exactly:
   PROMISE COMPLETE
Keep tasks small; keep changes small.

Board: <todo/doing/done snapshot>
Recent progress: <last N lines>
```

**B. Run-kickoff** — injected by `/ralph-run` as the first turn:
`"Start the Ralph run for <project>. Follow the kanban protocol. Begin with ralph_next."`

**C. Continuation** — injected after each `ralph_complete` (post-compaction):
`"Task committed. Continue: ralph_next for the next task, or output PROMISE COMPLETE if the board is empty."`

**D. Compaction-survival directive** — `session_before_compact`: tell the summarizer
to preserve only the run pointer (active project + current task id/status). The board
itself is re-injected from SQLite by (A), so the summary stays tiny.

## 9. Soft gate — the known risk

`ralph_complete` trusts the AI. The Ralph video + Anthropic both flag the failure:
the model marks done without truly verifying (esp. UI). v1 mitigations, all soft:
- The protocol prompt requires running `task.verify` before completing.
- One task per iteration keeps context budget for real verification (browser MCP etc.).
- One git commit per task → cheap rollback + bisect when something slips through.
- Out-of-band CI is the real safety net (must stay green).
Hard gate (runner executes `verify`, blocks done on failure) is the first future
enhancement — the schema already carries `verify`.

## 10. Open questions
- One active run at a time (simplest) vs multiple projects concurrently.
- Deadlock surfacing when all remaining todos are blocked by unmet deps.

Resolved: board is **read-only / non-interactive** (adds via tool); context is
**compacted after every task** (deterministic, not threshold-based).

## 11. Future enhancements (the deferred option-1s)
- **External runner**: fresh `pi --print` per task for true context reset, if
  in-session compaction proves insufficient.
- **Hard verify gate**: runner runs `task.verify`; done only on pass.
- **Interactive board**: add/edit/reprioritize/run from the TUI.
- **File mirror**: export `prd.json` + `progress.md` per project for git-diffable
  history (recover the Ralph-classic transparency SQLite gives up).
- **Notify hook**: desktop/WhatsApp ping on PROMISE COMPLETE.

## 12. Implementation phases (TDD; vitest + better-sqlite3, mock pi like capability-index)
1. **Data layer** — schema + CRUD: addTask, listTasks(filter), nextTask
   (priority + unblocked), claim, complete, appendProgress. Pure, fully unit-tested.
2. **Tools** — register `ralph_*` over the data layer; mock-pi tests.
3. **Injection** — `before_agent_start` protocol + live board snapshot.
4. **Loop driver** — continuation injection on complete, compaction trigger,
   max-iter backstop, PROMISE COMPLETE sentinel; `--once` mode.
5. **UI** — `/ralph` read-only board (TUI or text fallback).
6. **Commands** — `/ralph-add`, `/ralph-run`, `/ralph-note`.
```
extension: agent/extensions/pi-ralph/  (package.json pi.extensions=["./index.ts"],
  src/{db,tools,inject,loop,board}.ts, test/*, better-sqlite3)
```

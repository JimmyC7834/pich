import type { DB } from "./db.js";
import type { Status } from "./types.js";
import { listTasks, recentProgress } from "./store.js";

export function renderBoard(db: DB, project: string): string {
  const line = (label: string, s: Status) => {
    const ids = listTasks(db, project, s).map((t) => `‹p${t.priority}›${t.id}`);
    return `${label}: ${ids.join(", ") || "—"}`;
  };
  const prog = recentProgress(db, project, 6)
    .map((p) => `  · ${p.ts.slice(11, 16)} ${p.author} ${p.text}`)
    .join("\n") || "  (none)";
  return [
    `project: ${project}`,
    line("TODO", "todo"),
    line("DOING", "doing"),
    line("DONE", "done"),
    "progress (recent):",
    prog,
  ].join("\n");
}

export const SENTINEL = "PROMISE COMPLETE";

export function protocolBlock(project: string, board: string): string {
  return [
    `## Ralph kanban — active run: ${project}`,
    "You are the CONTROLLER. You do NOT implement directly — you delegate each",
    "task to fresh subagents and gate their work. Work ONE task at a time:",
    "1. ralph_next → highest-priority unblocked task. ralph_claim(id).",
    "2. Dispatch an IMPLEMENTER subagent (a fast/cheap model is enough for most",
    "   tasks) with the task's FULL spec + acceptance criteria. It implements,",
    "   runs the `verify` command until it passes, and git commits.",
    "3. Dispatch a REVIEWER subagent (a capable model) with FRESH context — give",
    "   it only the spec's acceptance criteria + the diff. It checks the code",
    "   actually meets the spec. Send any gaps back to the implementer subagent",
    "   and re-review until it passes. Do NOT review the work yourself.",
    "4. Only after the reviewer passes: ralph_complete(id, summary).",
    "5. ralph_progress: leave a note for the next iteration.",
    `6. Continue to the next task. If ralph_next returns nothing, output exactly: ${SENTINEL}`,
    "If a subagent reports it is BLOCKED or stuck, re-dispatch with more context",
    "or a more capable model — never force the same model to retry unchanged.",
    "Keep tasks small; keep changes small. Construct each subagent's context",
    "yourself — they do NOT share your history; paste what they need.",
    "Found follow-up work mid-task? Capture it with ralph_add (small, with",
    "acceptance criteria + a verify command) instead of expanding the current task.",
    "",
    board,
  ].join("\n");
}

export const KICKOFF = (project: string): string =>
  `Start the Ralph run for ${project}. Follow the kanban protocol above. Begin with ralph_next.`;

export const CONTINUATION =
  `Task committed. Continue: ralph_next for the next task, or output exactly "${SENTINEL}" if the board is empty.`;

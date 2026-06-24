import { Type } from "typebox";
import type { DB } from "./db.js";
import type { RunState } from "./loop.js";
import * as store from "./store.js";
import { renderBoard } from "./board.js";

export interface RalphCtx { db: DB; run: RunState; }

const txt = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";

export function makeRalphAdd(ctx: RalphCtx) {
  return {
    name: "ralph_add",
    label: "Ralph Add Task",
    description: "Add a task to a project's Ralph kanban backlog. A GOOD task is SMALL and self-contained; its `spec` states the behavior plus explicit acceptance criteria (ideally written as tests); `verify` is a shell command that proves it done. Example: { project: 'web', title: 'rate-limit login', spec: 'Reject >5 logins/min per IP with HTTP 429. Acceptance: (1) the 6th request within a minute returns 429; (2) a later minute resets the counter. Write these as tests first (TDD).', priority: 3, verify: 'npm test -- login-rate-limit' }. Avoid: vague specs, oversized tasks, or omitting `verify`.",
    promptSnippet: "ralph_add: add a kanban task (spec + acceptance)",
    parameters: Type.Object({
      project: Type.String(),
      title: Type.String(),
      spec: Type.String(),
      prd: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Number()),
      depends_on: Type.Optional(Type.Array(Type.String())),
      verify: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any) {
      store.ensureProject(ctx.db, p.project, p.project);
      const id = slug(p.title);
      store.addTask(ctx.db, {
        id, project: p.project, title: p.title, spec: p.spec, prd: p.prd,
        priority: p.priority, depends_on: p.depends_on, verify: p.verify, created_by: "ai",
      });
      return txt(`Added task '${id}' to ${p.project}.`);
    },
  };
}

export function makeRalphList(ctx: RalphCtx) {
  return {
    name: "ralph_list",
    label: "Ralph List",
    description: "Show the kanban board (todo/doing/done + recent progress) for a project.",
    promptSnippet: "ralph_list: show the kanban board",
    parameters: Type.Object({ project: Type.String() }),
    async execute(_id: string, p: any) {
      return txt(renderBoard(ctx.db, p.project));
    },
  };
}

export function makeRalphNext(ctx: RalphCtx) {
  return {
    name: "ralph_next",
    label: "Ralph Next",
    description: "Return the single highest-priority UNBLOCKED todo task for a project (or report the board is empty).",
    promptSnippet: "ralph_next: pick the next task",
    parameters: Type.Object({ project: Type.String() }),
    async execute(_id: string, p: any) {
      const t = store.nextTask(ctx.db, p.project);
      if (!t) {
        const blocked = store.blockedTasks(ctx.db, p.project);
        if (blocked.length) {
          const doneIds = new Set(store.listTasks(ctx.db, p.project, "done").map((d) => d.id));
          const lines = blocked.map((b) => {
            const unmet = b.depends_on.filter((d) => !doneIds.has(d));
            return `  ${b.id} waits on: ${unmet.join(", ")}`;
          });
          return txt(`DEADLOCK:\n${lines.join("\n")}`);
        }
        return txt("No unblocked todo tasks. If the board is empty, output PROMISE COMPLETE.");
      }
      const dep = t.depends_on.length ? ` depends_on=${JSON.stringify(t.depends_on)}` : "";
      const ver = t.verify ? `\nverify: ${t.verify}` : "";
      return txt(`Next: ${t.id} (priority ${t.priority})${dep}\nspec: ${t.spec}${t.prd ? `\nprd: ${t.prd}` : ""}${ver}`);
    },
  };
}

export function makeRalphClaim(ctx: RalphCtx) {
  return {
    name: "ralph_claim",
    label: "Ralph Claim",
    description: "Mark a task as in-progress (todo → doing).",
    promptSnippet: "ralph_claim: start a task",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id: string, p: any) {
      store.claimTask(ctx.db, p.id);
      return txt(`Claimed '${p.id}' (doing).`);
    },
  };
}

export function makeRalphComplete(ctx: RalphCtx) {
  return {
    name: "ralph_complete",
    label: "Ralph Complete",
    description: "Mark a task done and log a one-line summary to the project progress note. Call this only after the work is committed and (if present) its `verify` passed.",
    promptSnippet: "ralph_complete: finish a task",
    parameters: Type.Object({ id: Type.String(), summary: Type.String() }),
    async execute(_id: string, p: any) {
      store.completeTask(ctx.db, p.id, p.summary, "ai");
      ctx.run.iterations += 1;
      ctx.run.pendingContinue = true;
      return txt(`Completed '${p.id}'. Progress logged.`);
    },
  };
}

export function makeRalphProgress(ctx: RalphCtx) {
  return {
    name: "ralph_progress",
    label: "Ralph Progress",
    description: "Append a free-text note (learnings / handoff for the next iteration) to a project's progress log.",
    promptSnippet: "ralph_progress: append a progress note",
    parameters: Type.Object({
      project: Type.String(),
      text: Type.String(),
      task_id: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any) {
      store.appendProgress(ctx.db, p.project, p.text, "ai", p.task_id);
      return txt("Noted.");
    },
  };
}

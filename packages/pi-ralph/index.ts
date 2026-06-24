import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import { openRalphDb } from "./src/db.js";
import * as store from "./src/store.js";
import { renderBoard, protocolBlock, KICKOFF, CONTINUATION } from "./src/board.js";
import { loopDecision, shouldCompact, type RunState } from "./src/loop.js";
import {
  makeRalphAdd, makeRalphList, makeRalphNext, makeRalphClaim, makeRalphComplete, makeRalphProgress,
  type RalphCtx,
} from "./src/tools.js";

export default function (pi: ExtensionAPI) {
  // Default to one global board under the harness root (~/.pi/.pi/ralph), not the
  // per-cwd .pi/ralph — so runs in any workspace share the same backlog.
  // ponytail: global board by default; set RALPH_DB to scope a board per-repo.
  const dbFile = process.env["RALPH_DB"]
    ?? path.join(os.homedir(), ".pi", ".pi", "ralph", "ralph.db");
  const db = openRalphDb(dbFile);
  // Only compact between iterations once context exceeds this % of the window.
  const compactPct = Number(process.env["RALPH_COMPACT_PCT"] ?? 15);
  const run: RunState = {
    active: false, project: "", iterations: 0, max: 20, once: false, pendingContinue: false,
  };
  const ctx: RalphCtx = { db, run };

  for (const make of [
    makeRalphAdd, makeRalphList, makeRalphNext, makeRalphClaim, makeRalphComplete, makeRalphProgress,
  ]) pi.registerTool(make(ctx) as any);

  // Re-inject the protocol + live board every turn while a run is active
  // (survives compaction — board state lives in SQLite, not the transcript).
  pi.on("before_agent_start", async (event: any) => {
    if (!run.active) return;
    try {
      const block = protocolBlock(run.project, renderBoard(db, run.project));
      return { systemPrompt: event.systemPrompt + "\n\n" + block };
    } catch { return; } // fail open
  });

  // Loop driver: after a completion, compact and inject the next iteration —
  // or stop on empty board / max / --once.
  pi.on("turn_end", async (_event: any, c: any) => {
    if (!run.active) return; // no active run → no DB work this turn
    try {
      const action = loopDecision(run, store.nextTask(db, run.project) !== null);
      run.pendingContinue = false;
      if (action === "idle") return;
      if (action === "continue") {
        const percent = c.getContextUsage?.()?.percent;
        if (shouldCompact(percent, compactPct)) {
          c.compact({
            onComplete: () => pi.sendUserMessage(CONTINUATION),
            onError: (e: any) => c.hasUI && c.ui.notify(`Ralph compact failed: ${e?.message ?? e}`, "warning"),
          });
        } else {
          pi.sendUserMessage(CONTINUATION); // under threshold — continue without compacting
        }
        return;
      }
      run.active = false;
      store.setActiveRun(db, run.project, false);
      let why: string;
      if (action === "stop-empty") why = "PROMISE COMPLETE — board empty";
      else if (action === "stop-max") why = `stopped at max ${run.max} iterations`;
      else why = "single iteration done (--once)";
      if (c.hasUI) c.ui.notify(`Ralph [${run.project}]: ${why}`, "info");
    } catch { return; } // fail open
  });

  pi.registerCommand("ralph", {
    description: "Show the Ralph board: /ralph <project>",
    handler: async (args: string, c: any) => {
      const project = (args ?? "").trim() || run.project;
      if (!project) { if (c.hasUI) c.ui.notify("usage: /ralph <project>", "warning"); return; }
      if (c.hasUI) c.ui.notify(renderBoard(db, project), "info");
    },
  });

  pi.registerCommand("ralph-run", {
    description: "Start a Ralph run: /ralph-run <project> [--once] [--max N]",
    handler: async (args: string, c: any) => {
      const toks = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const project = toks[0];
      if (!project) { if (c.hasUI) c.ui.notify("usage: /ralph-run <project> [--once] [--max N]", "warning"); return; }
      const mi = toks.indexOf("--max");
      run.active = true;
      run.project = project;
      run.iterations = 0;
      run.pendingContinue = false;
      run.once = toks.includes("--once");
      run.max = mi >= 0 ? Number(toks[mi + 1]) : 20;
      store.ensureProject(db, project, project);
      store.setActiveRun(db, project, true);
      pi.sendUserMessage(KICKOFF(project));
    },
  });

  pi.registerCommand("ralph-add", {
    description: "Add a task: /ralph-add <project> :: <title> :: <spec>",
    handler: async (args: string, c: any) => {
      const parts = (args ?? "").split("::").map((s) => s.trim());
      if (parts.length < 3 || !parts[0] || !parts[1]) {
        if (c.hasUI) c.ui.notify("usage: /ralph-add <project> :: <title> :: <spec>", "warning");
        return;
      }
      const [project, title, spec] = parts;
      store.ensureProject(db, project, project);
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
      store.addTask(db, { id, project, title, spec, created_by: "human" });
      if (c.hasUI) c.ui.notify(`Added '${id}' to ${project}.`, "info");
    },
  });

  pi.registerCommand("ralph-note", {
    description: "Append a progress note: /ralph-note <project> <text>",
    handler: async (args: string, c: any) => {
      const s = (args ?? "").trim();
      const sp = s.indexOf(" ");
      if (sp < 0) { if (c.hasUI) c.ui.notify("usage: /ralph-note <project> <text>", "warning"); return; }
      store.appendProgress(db, s.slice(0, sp), s.slice(sp + 1), "human");
    },
  });
}

/**
 * pi-usage-recorder — observe-only token & context telemetry.
 *
 * Appends one row per assistant turn to <cwd>/.pi/usage/usage.jsonl (full token +
 * cache read/write + cost split, plus context-fill %), so the spend trend of a
 * session can be analysed offline. It registers NO context/prompt rewrite — it
 * changes nothing the model sees. This is the measurement foundation for the
 * pi-context-manager extension (compare usage.jsonl with the manager off vs on).
 *
 * Command: /usage  (this session) · /usage all (every recorded session)
 *
 * Conventions (shared with sibling extensions): fail-open everywhere — a dropped
 * row or a failed command must never disrupt the agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { usageFile } from "./src/paths.js";
import { newSessionId } from "./src/sessionid.js";
import { usageRowFromEvent } from "./src/row.js";
import { appendRow, readRows } from "./src/store.js";
import { renderSummary } from "./src/render.js";

export default function (pi: ExtensionAPI) {
  if (process.env["USAGE_RECORDER_DISABLE"]) return;

  const file = usageFile();
  let sessionId = newSessionId();

  pi.on("session_start", async () => {
    try { sessionId = newSessionId(); } catch { /* keep prior id */ }
  });

  // One row per assistant turn. turn_end carries { turnIndex, message, toolResults };
  // assistant messages carry `.usage`. Context fill comes from the handler's
  // ExtensionContext (2nd arg), which exposes getContextUsage().
  pi.on("turn_end", async (event: any, hctx: any) => {
    try {
      const ctx = hctx?.getContextUsage?.();
      const row = usageRowFromEvent(sessionId, event?.turnIndex ?? 0, event?.message, ctx, new Date().toISOString());
      if (row) appendRow(file, row);
    } catch { /* best-effort telemetry */ }
  });

  pi.registerCommand("usage", {
    description: "Token & context usage trend for this session (/usage all for every session)",
    handler: async (args: string, c: any) => {
      try {
        const all = (args ?? "").trim() === "all";
        const rows = readRows(file);
        const scoped = all ? rows : rows.filter((r) => r.sessionId === sessionId);
        if (c?.hasUI) c.ui.notify(renderSummary(scoped, all), "info");
      } catch { /* never break the prompt */ }
    },
  });
}

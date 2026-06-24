import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCapContext } from "./src/cap-context.js";
import { registerCommands } from "./src/commands.js";
import { capPolicy, type PolicyStyle } from "./src/policy.js";
import { slimSkillsBlock } from "./src/prompt-rewrite.js";
import { computeActiveIds } from "./src/promotion.js";
import { getCapabilities, upsertCapability, allIds, deleteCapability } from "./src/index-store.js";
import { recordSkillReadFromEvent, recordUsage, topRecentIds } from "./src/usage.js";
import { makeCapabilitySearch } from "./src/tools/capability_search.js";
import { makeCapabilityActivate } from "./src/tools/capability_activate.js";
import { makeCapabilityAdd } from "./src/tools/capability_add.js";
import { makeLoadout } from "./src/tools/loadout.js";
import { makeCapabilityStatus } from "./src/tools/capability_status.js";
import type { CapContext } from "./src/cap-context.js";
import { harvestTools, ALWAYS_ACTIVE } from "./src/harvest/tools.js";
import { computeActiveToolNames } from "./src/tool-deferral.js";

const PROMOTION_CEILING = Number(process.env["CAP_PROMOTION_CEILING"] ?? "5");

export default function (pi: ExtensionAPI) {
  const ctx = buildCapContext();
  for (const make of [makeCapabilitySearch, makeCapabilityActivate, makeCapabilityAdd, makeLoadout, makeCapabilityStatus])
    pi.registerTool(make(ctx) as any);
  registerCommands(pi, ctx);

  ctx.tools = { getActive: () => pi.getActiveTools(), setActive: (n: string[]) => pi.setActiveTools(n) };

  pi.on("session_start", async () => {
    try {
      ctx.refresh();                                          // skills
      indexTools(pi, ctx);                                    // native tools
      if (process.env["CAP_DEFER_TOOLS"]) applyToolDeferral(pi, ctx);
    } catch { /* index is rebuildable */ }
  });

  // Usage signal for promotion: count a skill as "used" when its SKILL.md is read.
  // PI carries the read's file_path on the `tool_result` event's `input` (NOT on
  // `tool_execution_end`, which has no args) — see ToolResultEventBase in PI types.
  pi.on("tool_result", async (event: any) => {
    try {
      recordSkillReadFromEvent(ctx.db, event);
      const tn: string = event?.toolName ?? "";
      if (tn && !ALWAYS_ACTIVE.has(tn)) recordUsage(ctx.db, `tool:pi:${tn}`);
    } catch { /* best-effort */ }
  });

  pi.on("before_agent_start", async (event: any) => {
    try {
      // FIXED injection — inject the STATIC loadout's skills only, identically
      // every turn. No usage-promotion, no session-activation churn: the active
      // set no longer changes turn-to-turn, so the system-prompt PREFIX stays
      // byte-identical across the session (prefix-cache friendly — a mutated
      // skills block near the top would otherwise force a cache miss on the whole
      // transcript below it). The capability_* tools stay registered for explicit
      // on-demand discovery; they just no longer rewrite the prefix per turn.
      const activeIds = ctx.loadouts.getActiveSkillIds();
      const skills = getCapabilities(ctx.db, activeIds).filter((c) => c.kind === "skill");
      let prompt = slimSkillsBlock(event.systemPrompt, skills);
      const policy = capPolicy((process.env["CAP_POLICY"] as PolicyStyle) || "compact");
      if (policy) prompt += "\n\n" + policy;
      return { systemPrompt: prompt };
    } catch {
      return; // fail open: leave PI's prompt untouched
    }
  });
}

function indexTools(pi: ExtensionAPI, ctx: CapContext): void {
  const caps = harvestTools(pi.getAllTools() as any);
  const fresh = new Set(caps.map((c) => c.id));
  for (const c of caps) upsertCapability(ctx.db, c);
  for (const id of allIds(ctx.db))
    if (id.startsWith("tool:") && !fresh.has(id)) deleteCapability(ctx.db, id);
}

function applyToolDeferral(pi: ExtensionAPI, ctx: CapContext): void {
  const strip = (id: string) => id.replace(/^tool:pi:/, "");
  const allToolNames = (pi.getAllTools() as any[]).map((t) => t.name);
  const deferrableNames = new Set(allIds(ctx.db).filter((id) => id.startsWith("tool:")).map(strip));
  const loadoutNames = ctx.loadouts.getActiveToolIds().map(strip);
  const sessionNames = [...ctx.sessionActive].filter((id) => id.startsWith("tool:")).map(strip);
  // promoted: frequently-used tools stay active across sessions (loadout ∪ session ∪ promoted)
  const promotedNames = topRecentIds(ctx.db, PROMOTION_CEILING, new Set())
    .filter((id) => id.startsWith("tool:")).map(strip);
  const keepNames = new Set([...loadoutNames, ...sessionNames, ...promotedNames]);
  const active = computeActiveToolNames({ allToolNames, deferrableNames, keepNames });
  pi.setActiveTools(active);
}

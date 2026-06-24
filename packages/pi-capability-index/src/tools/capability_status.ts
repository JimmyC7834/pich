import { Type } from "typebox";
import type { CapContext } from "../cap-context.js";
import { countByKind, getCapabilities } from "../index-store.js";
import { computeActiveIds } from "../promotion.js";
import { topRecentIds } from "../usage.js";

const CEILING = Number(process.env["CAP_PROMOTION_CEILING"] ?? "5");

/**
 * Ground-truth diagnostic. An agent can't read its own system prompt, so this reports
 * exactly what the `before_agent_start` hook will render into the slimmed
 * <available_skills> block this turn: indexed counts, active loadout, and the resolved
 * active set (loadout ∪ session-activated ∪ promoted).
 */
export function makeCapabilityStatus(ctx: CapContext) {
  return {
    name: "capability_status",
    label: "Capability Status",
    description: "Diagnostic: how many capabilities are indexed (by kind), the active loadout, and EXACTLY which skills the slimmed <available_skills> block will contain this turn (loadout ∪ session-activated ∪ promoted). Use to verify index/slimming/promotion without reading the system prompt.",
    promptSnippet: "capability_status: index + slim-block diagnostic",
    parameters: Type.Object({}),
    async execute() {
      const loadoutSkills = ctx.loadouts.getActiveSkillIds();
      const sessionActivated = [...ctx.sessionActive];
      const activeIds = computeActiveIds({
        loadoutIds: loadoutSkills, sessionIds: ctx.sessionActive, db: ctx.db, ceiling: CEILING,
      });
      const slimBlockWillShow = getCapabilities(ctx.db, activeIds)
        .filter((c) => c.kind === "skill").map((c) => c.name);
      const payload = {
        indexed: countByKind(ctx.db),
        activeLoadout: ctx.loadouts.getActive(),
        loadoutSkills,
        sessionActivated,
        promotedRecent: topRecentIds(ctx.db, CEILING, new Set([...loadoutSkills, ...sessionActivated])),
        slimBlockWillShow,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], details: {} };
    },
  };
}

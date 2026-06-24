import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CapContext } from "./cap-context.js";
import { countByKind } from "./index-store.js";

export function registerCommands(pi: ExtensionAPI, ctx: CapContext) {
  pi.registerCommand("loadout", {
    description: "List or switch capability loadouts: /loadout [name]",
    handler: async (args, c) => {
      const name = (args ?? "").trim();
      if (name) { ctx.loadouts.setActive(name); if (c.hasUI) c.ui.notify(`Active loadout: ${name}`, "info"); return; }
      const list = ctx.loadouts.listLoadouts().map((l) => l.name).join(", ") || "(none)";
      if (c.hasUI) c.ui.notify(`Loadouts: ${list} · active: ${ctx.loadouts.getActive()}`, "info");
    },
  });
  pi.registerCommand("cap-reindex", {
    description: "Rebuild the capability index from skills on disk",
    handler: async (_args, c) => { const n = ctx.refresh(); if (c.hasUI) c.ui.notify(`Capability index: ${n} skill(s)`, "info"); },
  });
  pi.registerCommand("cap-status", {
    description: "Show indexed capability counts + the active loadout",
    handler: async (_args, c) => {
      const counts = countByKind(ctx.db);
      const summary = Object.entries(counts).map(([k, n]) => `${k}:${n}`).join(", ") || "(empty)";
      if (c.hasUI) c.ui.notify(`Indexed [${summary}] · active loadout: ${ctx.loadouts.getActive()}`, "info");
    },
  });
}

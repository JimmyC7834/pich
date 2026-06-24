import { Type } from "typebox";
import type { CapContext } from "../cap-context.js";

export function makeLoadout(ctx: CapContext) {
  return {
    name: "loadout",
    label: "Loadout",
    description: "Manage capability loadouts (named always-on working sets). actions: list | create | update | delete | activate | add | remove | promote. The active loadout's skills stay in context; everything else is search-on-demand.",
    promptSnippet: "loadout: switch/curate the always-on capability set",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"),
        Type.Literal("activate"), Type.Literal("add"), Type.Literal("remove"), Type.Literal("promote"),
      ]),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      capability: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any) {
      const lo = ctx.loadouts;
      switch (p.action) {
        case "create": lo.createLoadout(p.name, { description: p.description }); break;
        case "update": lo.updateLoadout(p.name, { description: p.description }); break;
        case "delete": lo.deleteLoadout(p.name); break;
        case "activate": lo.setActive(p.name); break;
        case "add": lo.addCapability(p.name, p.capability); break;
        case "remove": lo.removeCapability(p.name, p.capability); break;
        case "promote": { const active = lo.getActive(); lo.addCapability(active, p.capability); break; }
        case "list": default: break;
      }
      const payload = { active: lo.getActive(), loadouts: lo.listLoadouts() };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], details: {} };
    },
  };
}

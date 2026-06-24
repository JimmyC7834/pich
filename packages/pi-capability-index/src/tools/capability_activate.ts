import { Type } from "typebox";
import type { CapContext } from "../cap-context.js";
import type { Capability, ActivationResult } from "../types.js";
import { getCapability } from "../index-store.js";
import { activatorFor } from "../activators/registry.js";

// Render the activation as actionable content the model uses THIS turn. The old
// `JSON.stringify({available:"next-turn",...})` made the model activate and then
// stop to wait for the user, because nothing in the result told it to proceed.
function render(cap: Capability, res: ActivationResult): string {
  const p = (res.payload ?? {}) as { filePath?: string; content?: string; toolName?: string; description?: string; params?: string };
  if (cap.kind === "skill") {
    if (p.content) return `Skill '${cap.id}' loaded — apply it now (do not stop to wait):\n\n${p.content}`;
    return `Skill '${cap.id}': read ${p.filePath ?? "its SKILL.md"} now and apply it (do not stop to wait).`;
  }
  if (cap.kind === "tool") {
    const params = p.params ? `\nparameters: ${p.params}` : "";
    return `Tool '${p.toolName}' is now active — call it now (do not stop to wait).\n${p.description ?? ""}${params}`;
  }
  return JSON.stringify(res);
}

export function makeCapabilityActivate(ctx: CapContext) {
  return {
    name: "capability_activate",
    label: "Capability Activate",
    description: "Load a capability found via capability_search, by id. For a skill it returns the full SKILL.md content to apply now; for a tool it enables the tool and returns its spec. Use the result immediately in the same turn — do not stop and wait for the user.",
    promptSnippet: "capability_activate: load a found capability by id (returns content to use now)",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id: string, p: any) {
      const cap = getCapability(ctx.db, p.id);
      if (!cap) return { content: [{ type: "text" as const, text: `Capability '${p.id}' not found. Run capability_search first.` }], details: {} };
      try {
        const act = activatorFor(cap.kind, { sessionActive: ctx.sessionActive, tools: ctx.tools });
        const res = act.activate(cap);
        return { content: [{ type: "text" as const, text: render(cap, res) }], details: { available: res.available, ...(res.payload as object) } };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Cannot activate '${p.id}': ${(e as Error).message}` }], details: {} };
      }
    },
  };
}

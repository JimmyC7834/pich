import type { Capability } from "../types.js";
import { flattenParams } from "../flatten.js";

/** Tools that must ALWAYS stay active and are never indexed/deferred. */
export const ALWAYS_ACTIVE = new Set<string>([
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "capability_search", "capability_activate", "capability_add", "loadout", "capability_status",
]);

export interface ToolInfoLike { name: string; description?: string; parameters?: unknown; }

export function toolToCapability(t: ToolInfoLike): Capability {
  const summary = t.description ?? "";
  return {
    id: `tool:pi:${t.name}`,
    kind: "tool",
    source: "pi",
    name: t.name,
    summary,
    searchText: { name: t.name, summary, params: flattenParams(t.parameters) },
    activation: { toolName: t.name },
  };
}

export function harvestTools(all: ToolInfoLike[]): Capability[] {
  return all.filter((t) => !ALWAYS_ACTIVE.has(t.name)).map(toolToCapability);
}

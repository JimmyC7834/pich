import { Type } from "typebox";
import type { CapContext } from "../cap-context.js";
import { capabilitySearch } from "../search.js";
import type { CapSearchResult } from "../types.js";

// Compact, lossless rendering of a search result. The id already encodes kind
// (prefix) and name (suffix), so `{id,kind,name,summary,score}` JSON repeated 8×
// with 2-space indent was ~3× heavier than it needs to be. One line per hit:
//   <score>  <id> — <summary>
// keeps every bit of signal (id, rank, summary) at a fraction of the tokens.
function render(res: CapSearchResult): string {
  if (res.hits.length === 0) {
    return res.next_steps.join(" ") || "No matching capability.";
  }
  const lines = res.hits.map((h) => `${h.score.toFixed(2)}  ${h.id} — ${h.summary}`);
  const head = `${res.hits.length} hits (${res.confidence} confidence). capability_activate(<id>) to load one.`;
  const tail = res.next_steps.length ? "\n" + res.next_steps.join(" ") : "";
  return [head, ...lines].join("\n") + tail;
}

export function makeCapabilitySearch(ctx: CapContext) {
  return {
    name: "capability_search",
    label: "Capability Search",
    description: "Find skills, tools, or MCP calls by task. Searches all three sets by default; pass kind to scope ('skill'|'tool'|'mcp'). Returns ranked lines '<score>  <id> — <summary>' (id encodes kind+name) — call capability_activate(id) to load one.",
    promptSnippet: "capability_search: find a skill/tool/mcp by task (ranked)",
    parameters: Type.Object({
      query: Type.String(),
      kind: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("tool"), Type.Literal("mcp"), Type.Literal("all")])),
      k: Type.Optional(Type.Number({ default: 8 })),
    }),
    async execute(_id: string, p: any) {
      const res = capabilitySearch(ctx.db, p.query, { kind: p.kind ?? "all", k: p.k ?? 8 });
      return { content: [{ type: "text" as const, text: render(res) }], details: { hits: res.hits, confidence: res.confidence } };
    },
  };
}

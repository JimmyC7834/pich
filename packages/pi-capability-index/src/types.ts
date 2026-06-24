export type Kind = "skill" | "tool" | "mcp";

export interface SearchText { name: string; summary: string; params: string; }

export interface Capability {
  id: string;            // `${kind}:${localName}` — stable, collision-free
  kind: Kind;
  source: string;        // skill baseDir / "pi" / mcp server id
  name: string;
  summary: string;
  searchText: SearchText;
  activation: unknown;    // kind-specific; consumed only by the Activator
}

export interface CapHit { id: string; kind: Kind; name: string; summary: string; score: number; }

export interface CapSearchResult {
  hits: CapHit[];
  confidence: "high" | "medium" | "low";
  next_steps: string[];
}

export interface Loadout {
  name: string;
  description: string;
  skills: string[];      // capability ids
  tools: string[];       // reserved (Phase 2)
  mcp: string[];         // reserved (Phase 3)
}

export interface ActivationResult { available: "now" | "next-turn"; payload?: unknown; }

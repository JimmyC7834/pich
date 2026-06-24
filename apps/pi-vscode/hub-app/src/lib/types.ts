export interface Loadout {
  name: string; description: string;
  skills: string[]; tools: string[]; mcp: string[];
}
export interface ToolEntry {
  name: string; description: string; schema?: unknown;
  source: string; sourcePath: string; isActive: boolean;
}
export interface SkillEntry {
  name: string; description: string; filePath: string;
  tags?: string[]; category?: string; isActive: boolean;
}
export interface KBDocEntry {
  id: string; title: string; filePath: string; tags?: string[];
}
export interface KBDocCollection {
  name: string; docs: KBDocEntry[];
}
export interface RalphTask {
  id: string; title: string; status: string; priority: number; done_at: string | null;
}
export interface RalphProject {
  id: string; name: string;
  todo: RalphTask[]; doing: RalphTask[]; done: RalphTask[];
}
export interface HubState {
  connected: boolean;
  collections: KBDocCollection[];
  skills: SkillEntry[];
  tools: ToolEntry[];
  loadouts: Loadout[];
  activeLoadout: string | null;
  ralph: RalphProject[];
  docContents: Record<string, string>;
}

// WIRE-PROTOCOL TYPES — must stay in sync with ../bridge/protocol.ts (the bridge's
// source of truth for WebSocket messages). They are duplicated rather than imported
// because the VS Code build uses rootDir:"src" and tsc refuses to emit a program that
// references files under bridge/ (TS6059). Keep the shared interfaces below (PiState …
// CapabilitiesSnapshot) byte-identical to protocol.ts when either side changes.
export interface PiState {
  model?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  activeTools?: string[];
  tokensInput?: number;
  tokensOutput?: number;
  cost?: number;
  turns?: number;
  toolCalls?: number;
  cwd?: string;
}

export interface SessionInfo {
  id: string;
  parentId?: string;
  role: string;
  type: string;
  children?: SessionInfo[];
}

export interface KBCollection {
  name: string;
  docCount: number;
}

export interface SkillItem {
  name: string;
  description: string;
  filePath: string;
}

export interface FileChange {
  path: string;
  status: "M" | "A" | "D";
  toolCallId: string;
}

export interface ToolEntry {
  name: string;
  description: string;
  schema?: unknown;
  source: string;
  sourcePath: string;
  isActive: boolean;
}

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  tags?: string[];
  category?: string;
  isActive: boolean;
}

export interface KBDocEntry {
  id: string;
  title: string;
  filePath: string;
  tags?: string[];
}

export interface KBDocCollection {
  name: string;
  docs: KBDocEntry[];
}

export interface CapabilitiesSnapshot {
  loadoutName?: string;
  activeTools: string[];
  activeSkills: string[];
  tools: ToolEntry[];
  skills: SkillEntry[];
  kBCollections: KBDocCollection[];
}

export interface Loadout {
  name: string; description: string;
  skills: string[]; tools: string[]; mcp: string[];
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

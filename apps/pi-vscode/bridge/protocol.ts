import type { Loadout } from "./loadoutGateway.js";
import type { RalphSnapshot } from "./ralph.js";
// ── pi-bridge → VS Code (push events) ──

export interface PiState {
  model?: string;
  thinkingLevel?: string;
  isStreaming: boolean;
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

export type PiToVSCode =
  | { type: "state"; data: PiState }
  | { type: "session_tree"; data: { sessions: SessionInfo[]; active: string } }
  | { type: "kb_collections"; data: { collections: KBCollection[] } }
  | { type: "file_changed"; data: { path: string; status: "M" | "A" | "D"; toolCallId: string } }
  | { type: "tool_start"; data: { toolName: string; toolCallId: string; path: string } }
  | { type: "skills"; data: { name: string; description: string; filePath: string }[] }
  | { type: "capabilities"; data: CapabilitiesSnapshot }
  | { type: "files_cleared" }
  | { type: "error"; data: { message: string } }
  | { type: "response"; id: string; data: unknown }
  | { type: "loadouts"; data: { loadouts: Loadout[]; active: string } }
  | { type: "ralph"; data: RalphSnapshot }
  | { type: "file_content"; data: { path: string; content: string } };

// ── VS Code → pi-bridge (commands) ──

export type VSCodeToPi =
  | { type: "fork"; entryId: string }
  | { type: "resume"; sessionFile: string }
  | { type: "kb_open"; id: string; docId: string; collection?: string }
  | { type: "kb_search"; id: string; query: string }
  | { type: "diff"; id: string; path: string }
  | { type: "command"; command: string }
  | { type: "refresh_capabilities" }
  | { type: "checkpoint" }
  | { type: "shutdown" }
  | { type: "loadout_list"; id: string }
  | { type: "loadout_create"; id: string; data: { name: string; description?: string; skills?: string[]; tools?: string[] } }
  | { type: "loadout_delete"; id: string; data: { name: string } }
  | { type: "loadout_update"; id: string; data: { name: string; description?: string; skills?: string[]; tools?: string[] } }
  | { type: "loadout_activate"; id: string; data: { name: string } }
  | { type: "tool_toggle"; id: string; data: { name: string; active: boolean } }
  | { type: "ralph_refresh" }
  | { type: "read_file"; id: string; data: { path: string } };

export function isVSCodeToPi(msg: unknown): msg is VSCodeToPi {
  return typeof msg === "object" && msg !== null && "type" in msg;
}

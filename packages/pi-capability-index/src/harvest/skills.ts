import { loadSkills, getAgentDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { Capability } from "../types.js";

export function skillToCapability(s: Skill): Capability {
  return {
    id: `skill:${s.name}`,
    kind: "skill",
    source: s.baseDir,
    name: s.name,
    summary: s.description,
    searchText: { name: s.name, summary: s.description, params: "" },
    activation: { skillDir: s.baseDir, filePath: s.filePath },
  };
}

export interface HarvestOpts { cwd: string; skillPaths?: string[]; includeDefaults?: boolean; }

export function harvestSkills(opts: HarvestOpts): Capability[] {
  const { skills } = loadSkills({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    skillPaths: opts.skillPaths ?? [],
    includeDefaults: opts.includeDefaults ?? true,
  });
  const byId = new Map<string, Capability>();
  for (const s of skills) { const c = skillToCapability(s); byId.set(c.id, c); }
  return [...byId.values()];
}

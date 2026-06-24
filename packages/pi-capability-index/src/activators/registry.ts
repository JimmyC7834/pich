import type { Kind } from "../types.js";
import type { Activator, ActivatorDeps } from "./types.js";
import { SkillActivator } from "./skill.js";
import { ToolActivator } from "./tool.js";

export function activatorFor(kind: Kind, deps: ActivatorDeps): Activator {
  switch (kind) {
    case "skill": return new SkillActivator(deps);
    case "tool": return new ToolActivator(deps);
    // "mcp" -> Phase 3
    default: throw new Error(`No activator for kind '${kind}' (built in a later phase)`);
  }
}

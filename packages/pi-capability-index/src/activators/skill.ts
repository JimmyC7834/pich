import type { Activator, ActivatorDeps } from "./types.js";
import type { Capability, ActivationResult } from "../types.js";
import { readFileSync } from "node:fs";

export class SkillActivator implements Activator {
  kind = "skill" as const;
  constructor(private deps: ActivatorDeps) {}
  activate(cap: Capability): ActivationResult {
    this.deps.sessionActive.add(cap.id);
    const filePath = (cap.activation as { filePath?: string })?.filePath;
    // Return the SKILL.md body inline so the model applies it THIS turn. The old
    // "next-turn" + path-only result made the model treat the skill as deferred
    // and stop to wait for the user instead of acting on it.
    let content: string | undefined;
    try { if (filePath) content = readFileSync(filePath, "utf8"); } catch { /* fall back to path */ }
    return { available: "now", payload: { filePath, content } };
  }
}

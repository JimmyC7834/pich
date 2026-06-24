import type { Activator, ActivatorDeps } from "./types.js";
import type { Capability, ActivationResult } from "../types.js";

export class ToolActivator implements Activator {
  kind = "tool" as const;
  constructor(private deps: ActivatorDeps) {}
  activate(cap: Capability): ActivationResult {
    const tc = this.deps.tools;
    if (!tc) throw new Error("tool activation unavailable (no tool controller wired)");
    const toolName = (cap.activation as { toolName?: string })?.toolName;
    if (!toolName) throw new Error(`capability ${cap.id} has no toolName`);
    this.deps.sessionActive.add(cap.id);
    const active = tc.getActive();
    if (!active.includes(toolName)) tc.setActive([...active, toolName]);
    // The tool is now in the active set, so it ships on the immediate follow-up
    // request and the model can call it without stopping. Return its spec inline
    // (description + params) so the model knows the signature right away.
    return { available: "now", payload: { toolName, description: cap.summary, params: cap.searchText.params } };
  }
}

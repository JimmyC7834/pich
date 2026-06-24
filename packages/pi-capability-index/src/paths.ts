import path from "node:path";

export function capabilityRoot(base: string, _scope: "global" | "project"): string {
  return path.join(base, ".pi", "capabilities");
}
export function dbPath(root: string): string { return path.join(root, "index.db"); }
export function loadoutsPath(root: string): string { return path.join(root, "loadouts.yaml"); }
// Authored skills go in a sibling of the capabilities root (~/.pi/skills); refresh() always
// harvests this dir so authored skills are never pruned.
export function authoredSkillsDir(root: string): string { return path.join(root, "..", "skills"); }

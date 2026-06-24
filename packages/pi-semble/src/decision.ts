import fs from "node:fs"; import path from "node:path";
import { projectCacheDir } from "./paths.js";

/** Per-repo state for whether semble should index this project. */
export type SembleDecision = "unset" | "enabled" | "disabled";

/** What session_start should do, derived from the decision + environment. */
export type StartupAction = "warm" | "prompt" | "auto-enable" | "skip";

export function enabledMarker(root: string): string { return path.join(projectCacheDir(root), ".enabled"); }
export function optOutMarker(root: string): string { return path.join(projectCacheDir(root), ".opt-out"); }
/** Legacy/freshness sentinel; its presence means the repo was indexed before this change. */
export function warmSignal(root: string): string { return path.join(projectCacheDir(root), ".warm-signal"); }

/** Read the repo's decision. opt-out wins; legacy `.warm-signal` counts as enabled. */
export function sembleDecision(root: string): SembleDecision {
  try { if (fs.existsSync(optOutMarker(root))) return "disabled"; } catch { /* ignore */ }
  try { if (fs.existsSync(enabledMarker(root)) || fs.existsSync(warmSignal(root))) return "enabled"; } catch { /* ignore */ }
  return "unset";
}

/** Persist the user's choice as a marker under the (git-ignored) cache dir. */
export function setSembleDecision(root: string, decision: "enabled" | "disabled"): void {
  const dir = projectCacheDir(root);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", "utf-8"); } catch { /* ignore */ }
  if (decision === "enabled") {
    try { fs.rmSync(optOutMarker(root), { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(enabledMarker(root), "1", "utf-8");
  } else {
    try { fs.rmSync(enabledMarker(root), { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(optOutMarker(root), "1", "utf-8");
  }
}

/**
 * Decide what session_start should do for a code repo.
 * Pure: no side effects, so the branching matrix is unit-testable.
 */
export function plannedAction(decision: SembleDecision, hasUI: boolean, autoInit: boolean): StartupAction {
  if (decision === "disabled") return "skip";
  if (decision === "enabled") return "warm";
  // unset:
  if (autoInit) return "auto-enable";
  return hasUI ? "prompt" : "skip";
}

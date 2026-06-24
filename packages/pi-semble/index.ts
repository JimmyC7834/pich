import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import fs from "node:fs"; import path from "node:path";
import { makeCodeSearch } from "./src/tools/code_search.js";
import { makeKbSearch } from "./src/tools/kb_search.js";
import { makeFindRelated } from "./src/tools/find_related.js";
import { makeKbIngest } from "./src/tools/kb_ingest.js";
import { classifyDiscovery } from "./src/guard.js";
import { detectTargets, freshnessSignal } from "./src/detect.js";
import { projectCacheDir, globalCacheDir, hfHome } from "./src/paths.js";
import { sembleDecision, setSembleDecision, plannedAction } from "./src/decision.js";
import { sembleSearch } from "./src/engine.js";

export default function (pi: ExtensionAPI) {
  if (process.env["PI_SEMBLE_DISABLE"]) return;
  for (const make of [makeCodeSearch, makeKbSearch, makeFindRelated, makeKbIngest]) pi.registerTool(make() as any);

  // Freshness-gated, fire-and-forget cache build. Never await, never block.
  function warm(t: ReturnType<typeof detectTargets>): void {
    // Re-arm the one-shot discovery guard for this session (sentinel persists on disk otherwise).
    try { fs.rmSync(path.join(projectCacheDir(t.repoRoot), ".guard-shot"), { force: true }); } catch { /* ignore */ }
    const sentinel = path.join(projectCacheDir(t.repoRoot), ".warm-signal");
    const sig = freshnessSignal(t.repoRoot);
    let prev = ""; try { prev = fs.readFileSync(sentinel, "utf-8"); } catch { /* none */ }
    const stale = prev !== sig || sig === "nogit";
    if (t.isCode && stale) void sembleSearch("warm", { repo: t.repoRoot, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(), content: "code", topK: 1, maxSnippetLines: 0 });
    if (t.projectKb && stale) void sembleSearch("warm", { repo: t.projectKb, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(), content: "docs", topK: 1, maxSnippetLines: 0 });
    if (t.globalKb) void sembleSearch("warm", { repo: t.globalKb, cacheDir: globalCacheDir(), hfHome: hfHome(), content: "docs", topK: 1, maxSnippetLines: 0 });
    try { fs.mkdirSync(projectCacheDir(t.repoRoot), { recursive: true }); fs.writeFileSync(sentinel, sig, "utf-8"); fs.writeFileSync(path.join(projectCacheDir(t.repoRoot), ".gitignore"), "*\n", "utf-8"); } catch { /* ignore */ }
  }

  // On a new pwd, ask before indexing; remember the answer. Already-handled repos warm silently.
  pi.on("session_start", async (_event, ctx) => {
    try {
      const t = detectTargets(process.cwd());
      if (!t.isCode) return;
      const action = plannedAction(sembleDecision(t.repoRoot), !!ctx?.hasUI, !!process.env["PI_SEMBLE_AUTO_INIT"]);
      if (action === "skip") return;
      if (action === "auto-enable") { setSembleDecision(t.repoRoot, "enabled"); warm(t); return; }
      if (action === "warm") { warm(t); return; }
      // action === "prompt": new repo with UI — ask once.
      let yes = false;
      try {
        yes = await ctx.ui.confirm(
          "Initialize semble?",
          "Build a local code/doc search index for this project? First run downloads a ~64 MB model.",
        );
      } catch { return; /* dialog failed — leave unset, ask again next session */ }
      setSembleDecision(t.repoRoot, yes ? "enabled" : "disabled");
      if (yes) warm(t);
    } catch { /* fail-open */ }
  });

  // Proactive: tell the model upfront to prefer the semble tools over grep/find/read.
  pi.on("before_agent_start", async (event: any) => {
    try {
      const t = detectTargets(process.cwd());
      if (!t.isCode || sembleDecision(t.repoRoot) !== "enabled") return;
      const note = [
        "## Code/doc search (semble index present) - prefer over grep/find for discovery",
        "To find code by behavior or name use `repo_search`; for the sourced doc library use `kb_search`; for siblings/callers/tests of a location use `find_related`. These are ranked and fast - do NOT grep/find files just to discover where something lives.",
      ].join("\n");
      return { systemPrompt: event.systemPrompt + "\n\n" + note };
    } catch { return; /* fail-open */ }
  });

  // One-shot per session: teach the tools when the agent does manual code discovery.
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    try {
      const t = detectTargets(process.cwd());
      if (!t.isCode || sembleDecision(t.repoRoot) !== "enabled") return;
      const sentinel = path.join(projectCacheDir(t.repoRoot), ".guard-shot");
      if (fs.existsSync(sentinel)) return;
      const { hit, hint } = classifyDiscovery(event.toolName, event.input);
      if (!hit) return;
      try { fs.mkdirSync(projectCacheDir(t.repoRoot), { recursive: true }); fs.writeFileSync(sentinel, "1", "utf-8"); } catch { /* ignore */ }
      const shot = [
        `You used \`${hint}\` to explore the codebase, but this project has a semble index.`,
        "Prefer the dedicated tools - hybrid semantic+lexical, file:line out:",
        "  - `repo_search({ query })` - find code by behavior or name",
        "  - `kb_search({ query })` - search the sourced doc library",
        "  - `find_related({ file_path, line })` - sibling implementations / callers / tests",
      ].join("\n");
      ctx.ui?.notify?.("Redirecting code discovery to semble tools", "info");
      // Inline delivery: the blocked tool's `reason` surfaces with THIS tool call in
      // the current turn. (A `sendUserMessage(..., followUp)` here would arrive after
      // the turn finishes — too late to redirect the call that triggered it.)
      return { block: true, reason: shot };
    } catch { return; }
  });
}

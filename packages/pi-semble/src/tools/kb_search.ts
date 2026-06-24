import { Type } from "typebox";
import { sembleSearch } from "../engine.js";
import { detectTargets } from "../detect.js";
import { projectCacheDir, globalCacheDir, hfHome } from "../paths.js";
import { buildSupersededSet, annotateKbHits, type KbHit } from "../provenance.js";
import { formatHits } from "../format.js";
const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function makeKbSearch() {
  return {
    name: "kb_search",
    label: "KB Search",
    description: "Search the knowledge library (sourced markdown docs) with hybrid semantic+lexical retrieval (semble). Scope: project, global, or both (default). Returns ranked doc chunks with authority + sources; superseded docs are hidden. To write a sourced note use kb_write.",
    promptSnippet: "search the doc library (project + global)",
    parameters: Type.Object({
      query: Type.String({ description: "What you want to know." }),
      scope: Type.Optional(Type.String({ description: "project | global | both (default both)." })),
      top_k: Type.Optional(Type.Number({ description: "Max results (default 8)." })),
      snippets: Type.Optional(Type.Boolean({ description: "Include doc snippet lines (default true)." })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const t = detectTargets(process.cwd());
      const scope = String(p?.scope ?? "both");
      const topK = Number(p?.top_k ?? 8);
      const snippets = p?.snippets !== false;
      const maxSnippetLines = snippets ? null : 0;
      const wantProject = (scope === "project" || scope === "both") && !!t.projectKb;
      const wantGlobal = (scope === "global" || scope === "both") && !!t.globalKb;

      const all: KbHit[] = [];
      if (wantProject) {
        const hits = await sembleSearch(String(p?.query ?? ""), {
          repo: t.projectKb!, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(),
          content: "docs", topK, maxSnippetLines,
        }, signal);
        all.push(...annotateKbHits(hits, t.projectKb!, buildSupersededSet([t.projectKb!])).map(h => ({ ...h, score: h.score + 0.001 }))); // project tiebreak boost
      }
      if (wantGlobal) {
        const hits = await sembleSearch(String(p?.query ?? ""), {
          repo: t.globalKb!, cacheDir: globalCacheDir(), hfHome: hfHome(),
          content: "docs", topK, maxSnippetLines,
        }, signal);
        all.push(...annotateKbHits(hits, t.globalKb!, buildSupersededSet([t.globalKb!])));
      }
      if (!wantProject && !wantGlobal) return out("kb_search: no knowledge library found (project or global).");
      all.sort((a, b) => b.score - a.score);
      return out(formatHits(all.slice(0, topK), { snippets }));
    },
  };
}

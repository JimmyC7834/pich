import { Type } from "typebox";
import { sembleSearch } from "../engine.js";
import { detectTargets } from "../detect.js";
import { projectCacheDir, hfHome } from "../paths.js";
import { formatHits } from "../format.js";

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function makeCodeSearch() {
  return {
    name: "repo_search",
    label: "Repo Search",
    description: "Hybrid semantic+lexical search over THIS local repo's source (semble). Returns file:line ranked chunks — navigate directly, do not grep again. (Local code only; for external code examples/docs from the web use code_search; for the doc library use kb_search; for the definition map use the atlas.)",
    promptSnippet: "semantic search over this repo's local code (file:line)",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or code query (behavior or symbol name)." }),
      top_k: Type.Optional(Type.Number({ description: "Max results (default 6)." })),
      snippets: Type.Optional(Type.Boolean({ description: "Include code snippet lines (default false)." })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const t = detectTargets(process.cwd());
      if (!t.isCode) return out("repo_search: not a code repo (nothing indexed).");
      const hits = await sembleSearch(String(p?.query ?? ""), {
        repo: t.repoRoot, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(),
        content: "code", topK: Number(p?.top_k ?? 6), maxSnippetLines: p?.snippets ? null : 0,
      }, signal);
      return out(formatHits(hits, { snippets: !!p?.snippets }));
    },
  };
}

import { Type } from "typebox";
import { sembleFindRelated, toIndexPath } from "../engine.js";
import { detectTargets } from "../detect.js";
import { projectCacheDir, hfHome } from "../paths.js";
import { formatHits } from "../format.js";
const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function makeFindRelated() {
  return {
    name: "find_related",
    label: "Find Related",
    description: "Find code semantically similar to a specific file:line in THIS repo (semble find_related). Use after repo_search to discover sibling implementations, callers, or tests. Pass file_path + line from a prior result.",
    promptSnippet: "find code similar to a file:line",
    parameters: Type.Object({
      file_path: Type.String({ description: "File path as shown in a search result." }),
      line: Type.Number({ description: "1-indexed line number." }),
      top_k: Type.Optional(Type.Number({ description: "Max results (default 5)." })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const t = detectTargets(process.cwd());
      const hits = await sembleFindRelated(toIndexPath(String(p?.file_path ?? "")), Number(p?.line ?? 1), {
        repo: t.repoRoot, cacheDir: projectCacheDir(t.repoRoot), hfHome: hfHome(),
        topK: Number(p?.top_k ?? 5), maxSnippetLines: 0,
      }, signal);
      return out(formatHits(hits));
    },
  };
}

import { Type } from "typebox";
import { createHash } from "node:crypto";
import fs from "node:fs"; import path from "node:path";
import { detectTargets } from "../detect.js";
import { projectKbWriteRoot, globalKbWriteRoot } from "../paths.js";
import { serializeDoc } from "../frontmatter.js";
import { scanSecrets } from "../secrets.js";

const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "note";
const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6);

export function makeKbIngest() {
  return {
    name: "kb_ingest",
    label: "KB Ingest",
    description: "Add a SOURCED document to the knowledge library (markdown files that kb_search then indexes). Provide inline `body` OR a local `from_path` to import. `sources` is REQUIRED (provenance). scope: project | global (default global). Body is secret-scanned. Use for reference-worthy, citable knowledge.",
    promptSnippet: "ingest a sourced doc into the knowledge library",
    parameters: Type.Object({
      title: Type.String({ description: "Human title for the doc." }),
      collection: Type.String({ description: "Collection id (folder; created if new)." }),
      body: Type.Optional(Type.String({ description: "Inline markdown content." })),
      from_path: Type.Optional(Type.String({ description: "Local file whose content becomes the body." })),
      sources: Type.Array(Type.Object({
        url: Type.Optional(Type.String()), path: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()), locator: Type.Optional(Type.String()),
      }), { description: "REQUIRED provenance — at least one." }),
      tags: Type.Optional(Type.Array(Type.String())),
      authority: Type.Optional(Type.String({ description: "reference | curated | agent-note (default agent-note)." })),
      scope: Type.Optional(Type.String({ description: "project | global (default global)." })),
      supersedes: Type.Optional(Type.String({ description: "id of a doc this replaces (hidden from search)." })),
    }),
    async execute(_id: string, p: any) {
      try {
        const title = String(p?.title ?? "").trim();
        if (!title) return out("kb_ingest: `title` is required.");
        const collection = String(p?.collection ?? "").trim();
        if (!collection) return out("kb_ingest: `collection` is required.");

        let body = typeof p?.body === "string" ? p.body : "";
        const sources: any[] = Array.isArray(p?.sources) ? [...p.sources] : [];
        if (p?.from_path) {
          try { body = fs.readFileSync(String(p.from_path), "utf-8"); }
          catch (e: any) { return out(`kb_ingest: cannot read from_path: ${e?.message ?? e}`); }
          if (!sources.some((s) => s?.path || s?.url)) sources.push({ path: String(p.from_path) });
        }
        if (!body.trim()) return out("kb_ingest: provide `body` or a readable `from_path`.");
        if (sources.length === 0) return out("kb_ingest: refused — at least one source is required (provenance).");

        const secrets = scanSecrets(body);
        if (secrets.length) return out(`kb_ingest: refused — possible secret(s): ${secrets.join(", ")}. Remove them before ingesting.`);

        const scope = String(p?.scope ?? "global") === "project" ? "project" : "global";
        const t = detectTargets(process.cwd());
        const kbRoot = scope === "project" ? projectKbWriteRoot(t.repoRoot) : globalKbWriteRoot();
        const now = new Date().toISOString();
        const id = `${slug(title)}-${shortHash(title + now)}`;
        const authority = ["reference", "curated", "agent-note"].includes(String(p?.authority)) ? String(p.authority) : "agent-note";
        const description = (body.split("\n").find((l: string) => l.trim() && !/^#{1,6}\s/.test(l)) ?? "").trim().slice(0, 200);

        const fm: Record<string, unknown> = {
          id, title, description, tags: Array.isArray(p?.tags) ? p.tags : [],
          authority, sources, created_at: now, updated_at: now,
        };
        if (p?.supersedes) fm.supersedes = String(p.supersedes);

        const dir = path.join(kbRoot, "collections", collection, "docs");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.md`);
        fs.writeFileSync(file, serializeDoc(fm, body), "utf-8");
        return out(`Ingested "${title}" → ${file}\n(id ${id}, ${scope} scope, ${sources.length} source(s)). kb_search picks it up on the next query.`);
      } catch (e: any) {
        return out(`kb_ingest failed: ${e?.message ?? String(e)}`);
      }
    },
  };
}

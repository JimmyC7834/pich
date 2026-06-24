import { Type } from "typebox";
import fs from "node:fs"; import path from "node:path";
import type { CapContext } from "../cap-context.js";
import { capabilitySearch } from "../search.js";
import { findSecret } from "../secrets.js";
import { skillToCapability } from "../harvest/skills.js";
import { upsertCapability } from "../index-store.js";

export function makeCapabilityAdd(ctx: CapContext) {
  return {
    name: "capability_add",
    label: "Capability Add (author a skill)",
    description: "Author a new packaged skill: scaffolds a SKILL.md (frontmatter + body) and indexes it. Warns on a near-duplicate (dedup) and refuses content containing secrets.",
    promptSnippet: "capability_add: author + index a new skill",
    parameters: Type.Object({
      name: Type.String(),
      description: Type.String(),
      body: Type.String(),
    }),
    async execute(_id: string, p: any) {
      if (findSecret(p.body) || findSecret(p.description))
        return { content: [{ type: "text" as const, text: "Refused: content appears to contain a secret (API key / private key). Remove it and retry." }], details: {} };

      const dup = capabilitySearch(ctx.db, `${p.name} ${p.description}`, { kind: "skill", k: 1 });
      const warn = dup.confidence === "high" && dup.hits[0] ? ` (note: similar existing skill '${dup.hits[0].id}')` : "";

      const dir = path.join(ctx.authoredDir, p.name);   // ~/.pi/skills/<name>/ — harvested by refresh()
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "SKILL.md");
      const fm = `---\nname: ${p.name}\ndescription: ${p.description}\n---\n\n${p.body}\n`;
      fs.writeFileSync(file, fm);

      const cap = skillToCapability({ name: p.name, description: p.description, filePath: file,
        baseDir: dir, sourceInfo: {} as any, disableModelInvocation: false } as any);
      upsertCapability(ctx.db, cap);
      return { content: [{ type: "text" as const, text: `Authored skill '${p.name}' at ${file}${warn}` }], details: {} };
    },
  };
}

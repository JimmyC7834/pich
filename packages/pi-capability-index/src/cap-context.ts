import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DB } from "./db.js";
import { openDb } from "./db.js";
import { capabilityRoot, dbPath, loadoutsPath, authoredSkillsDir } from "./paths.js";
import { harvestSkills } from "./harvest/skills.js";
import { upsertCapability, allIds, deleteCapability } from "./index-store.js";
import { LoadoutService } from "./loadouts.js";
import type { ToolControl } from "./activators/types.js";

export interface CapContext {
  db: DB;
  root: string;
  loadouts: LoadoutService;
  sessionActive: Set<string>;
  cwd: string;
  skillPaths: string[];
  includeDefaults: boolean;
  authoredDir: string;
  tools?: ToolControl;
  refresh(): number;
}

export interface CapContextOpts {
  homeDir?: string; cwd?: string; skillPaths?: string[]; includeDefaults?: boolean;
}

export function buildCapContext(opts?: CapContextOpts): CapContext {
  const home = opts?.homeDir ?? os.homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const root = capabilityRoot(home, "global");
  fs.mkdirSync(root, { recursive: true });
  ensureGitignore(root);
  const db = openDb(dbPath(root));
  const loadouts = new LoadoutService(loadoutsPath(root));
  const ctx: CapContext = {
    db, root, loadouts, sessionActive: new Set<string>(), cwd,
    skillPaths: opts?.skillPaths ?? [],
    includeDefaults: opts?.includeDefaults ?? true,
    authoredDir: authoredSkillsDir(root),
    refresh() {
      // Scan ONLY bounded, cwd-INDEPENDENT skill roots. We never pass includeDefaults:true
      // to loadSkills, because that makes it scan `<cwd>/.pi/skills` — i.e. wherever pi was
      // launched — which (a) can recurse a huge/symlinked tree and freeze this synchronous
      // reindex, and (b) is wrong: the GLOBAL index must not depend on the launch directory.
      // `includeDefaults` here just opts into PI's user-skills dir (~/.pi/agent/skills).
      const roots = [
        ...ctx.skillPaths,
        ctx.authoredDir,                                      // ~/.pi/skills (capability_add output)
        ...(ctx.includeDefaults ? [path.join(getAgentDir(), "skills")] : []), // PI user skills
      ];
      const paths = [...new Set(roots)].filter((p) => fs.existsSync(p));
      const caps = harvestSkills({ cwd: ctx.cwd, skillPaths: paths, includeDefaults: false });
      const fresh = new Set(caps.map((c) => c.id));
      for (const c of caps) upsertCapability(db, c);
      // drop skills that disappeared from disk (keep tool/mcp rows from later phases)
      for (const id of allIds(db)) if (id.startsWith("skill:") && !fresh.has(id)) deleteCapability(db, id);
      return caps.length;
    },
  };
  return ctx;
}

function ensureGitignore(root: string) {
  const gi = path.join(root, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "index.db\nindex.db-*\n");
}

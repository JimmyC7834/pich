import fs from "node:fs"; import path from "node:path";
import { parse, stringify } from "yaml";
import type { Loadout } from "./types.js";

interface FileShape { core: string[]; active: string; loadouts: Record<string, Loadout>; }

export class LoadoutService {
  constructor(private file: string) {}

  private read(): FileShape {
    if (!fs.existsSync(this.file)) return { core: [], active: "base", loadouts: {} };
    try { const d = parse(fs.readFileSync(this.file, "utf-8")) ?? {};
      return { core: d.core ?? [], active: d.active ?? "base", loadouts: d.loadouts ?? {} };
    } catch { return { core: [], active: "base", loadouts: {} }; }
  }
  private write(d: FileShape): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, stringify(d));
  }

  listLoadouts(): Loadout[] { return Object.values(this.read().loadouts); }
  getLoadout(name: string): Loadout | null { return this.read().loadouts[name] ?? null; }

  createLoadout(name: string, init: Partial<Loadout> = {}): void {
    const d = this.read();
    d.loadouts[name] = { name, description: init.description ?? "",
      skills: init.skills ?? [], tools: init.tools ?? [], mcp: init.mcp ?? [] };
    this.write(d);
  }
  updateLoadout(name: string, patch: Partial<Loadout>): void {
    const d = this.read(); const cur = d.loadouts[name]; if (!cur) return;
    d.loadouts[name] = { ...cur, ...patch, name: patch.name ?? cur.name };
    if (patch.name && patch.name !== name) { d.loadouts[patch.name] = d.loadouts[name]; delete d.loadouts[name]; }
    this.write(d);
  }
  addCapability(name: string, capId: string): void {
    const d = this.read(); const lo = d.loadouts[name]; if (!lo) return;
    const list = capId.startsWith("mcp:") ? lo.mcp : capId.startsWith("tool:") ? lo.tools : lo.skills;
    if (!list.includes(capId)) list.push(capId);
    this.write(d);
  }
  removeCapability(name: string, capId: string): void {
    const d = this.read(); const lo = d.loadouts[name]; if (!lo) return;
    lo.skills = lo.skills.filter((x) => x !== capId);
    lo.tools = lo.tools.filter((x) => x !== capId);
    lo.mcp = lo.mcp.filter((x) => x !== capId);
    this.write(d);
  }
  deleteLoadout(name: string): void { const d = this.read(); delete d.loadouts[name]; this.write(d); }

  getActive(): string { return this.read().active; }
  setActive(name: string): void { const d = this.read(); d.active = name; this.write(d); }
  setCore(ids: string[]): void { const d = this.read(); d.core = ids; this.write(d); }

  getActiveSkillIds(): string[] {
    const d = this.read();
    const lo = d.loadouts[d.active];
    const ids = new Set<string>([...d.core, ...(lo?.skills ?? [])]);
    return [...ids].filter((id) => id.startsWith("skill:"));
  }
  getActiveToolIds(): string[] {
    const d = this.read();
    const lo = d.loadouts[d.active];
    const ids = new Set<string>([...d.core, ...(lo?.tools ?? [])]);
    return [...ids].filter((id) => id.startsWith("tool:"));
  }
  validate(name: string, known: Set<string>): string[] {
    const lo = this.getLoadout(name); if (!lo) return [];
    return [...lo.skills, ...lo.tools, ...lo.mcp].filter((id) => !known.has(id));
  }
}

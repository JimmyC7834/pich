import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

export interface Loadout {
  name: string; description: string;
  skills: string[]; tools: string[]; mcp: string[];
}
interface FileShape { core: string[]; active: string; loadouts: Record<string, Loadout>; }

export class LoadoutGateway {
  constructor(private file: string) {}

  private read(): FileShape {
    if (!fs.existsSync(this.file)) return { core: [], active: "base", loadouts: {} };
    try {
      const d = parse(fs.readFileSync(this.file, "utf-8")) ?? {};
      return { core: d.core ?? [], active: d.active ?? "base", loadouts: d.loadouts ?? {} };
    } catch { return { core: [], active: "base", loadouts: {} }; }
  }
  private write(d: FileShape): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, stringify(d));
  }
  private blank(name: string, init: Partial<Loadout> = {}): Loadout {
    return { name, description: init.description ?? "",
      skills: init.skills ?? [], tools: init.tools ?? [], mcp: init.mcp ?? [] };
  }

  list(): Loadout[] { return Object.values(this.read().loadouts); }
  get(name: string): Loadout | null { return this.read().loadouts[name] ?? null; }
  getActive(): string { return this.read().active; }
  snapshot(): { loadouts: Loadout[]; active: string } {
    const d = this.read();
    return { loadouts: Object.values(d.loadouts), active: d.active };
  }
  create(name: string, init: Partial<Loadout> = {}): void {
    const d = this.read(); d.loadouts[name] = this.blank(name, init); this.write(d);
  }
  update(name: string, patch: Partial<Loadout>): void {
    const d = this.read(); const cur = d.loadouts[name]; if (!cur) return;
    const next = { ...cur, ...patch, name: patch.name ?? cur.name };
    if (patch.name && patch.name !== name) delete d.loadouts[name];
    d.loadouts[next.name] = next; this.write(d);
  }
  addCap(name: string, capId: string): void {
    const d = this.read(); const lo = d.loadouts[name]; if (!lo) return;
    const list = capId.startsWith("mcp:") ? lo.mcp : capId.startsWith("tool:") ? lo.tools : lo.skills;
    if (!list.includes(capId)) list.push(capId);
    this.write(d);
  }
  removeCap(name: string, capId: string): void {
    const d = this.read(); const lo = d.loadouts[name]; if (!lo) return;
    lo.skills = lo.skills.filter((x) => x !== capId);
    lo.tools = lo.tools.filter((x) => x !== capId);
    lo.mcp = lo.mcp.filter((x) => x !== capId);
    this.write(d);
  }
  remove(name: string): void { const d = this.read(); delete d.loadouts[name]; this.write(d); }
  setActive(name: string): void { const d = this.read(); d.active = name; this.write(d); }
}

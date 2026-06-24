/**
 * Capability Browser — human-facing overlay popups for inspecting what the
 * agent's capability layers contain. Three read-only commands, one shared UI:
 *
 *   /skills  — packaged skills      (file-scanned from ~/.pi/skills/*\/SKILL.md)
 *   /tools   — native PI tools      (read from pi-capability-index  index.db)
 *   /docs    — research-library docs (read from pi-research-library index.db)
 *
 * Usage: pi --extension ~/.pi/agent/extensions/capability-browser.ts
 *
 * ── Design notes for future agents ───────────────────────────────────────────
 * This is a *human* inspector. It is deliberately decoupled from agent state:
 * browsing never loads a skill, activates a tool, or opens a doc. It mirrors
 * exactly what the agent-facing indexes hold, so a human can sanity-check them.
 *
 * Data flow: each command has a tiny LOADER that returns `Entry[]`, then opens
 * the SAME generic `EntryBrowser` overlay. The browser knows nothing about
 * skills/tools/docs — only `{ name, description, category, meta }`. To add a
 * fourth browser (e.g. /mcp once Phase 3 lands): write a `loadX(): Entry[]`
 * loader and register one more command calling `openBrowser(pi, { ... })`.
 *
 * SQLite access wrinkle: this file is loaded loose (`pi --extension <file>`),
 * so it has no node_modules of its own and CANNOT import `better-sqlite3`
 * directly — PI's own install ships no SQLite. We therefore reach SQLite by
 * importing the sibling *packages'* `openDb` helpers via relative path; jiti
 * resolves their `better-sqlite3` against their node_modules. This couples the
 * UI to sibling internals, but everything lives in one harness and it
 * guarantees we show precisely what the agent's index holds. If a DB is absent
 * or a query throws, the loader returns [] (fail-open empty state) — the
 * overlay must never crash the session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-tui";
import { matchesKey, Key, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
// Local read-only SQLite opener (this file now lives inside the package).
import { openDb as openCapDb } from "./src/db.js";

// ── shared entry shape ───────────────────────────────────────────────────────
// Every browser reduces its domain object to this. `meta` is an optional
// secondary line shown in the detail panel (a path, an id — whatever helps a
// human locate the thing); leave it "" if there's nothing useful.

export interface Entry {
  name: string;
  description: string;
  category: string; // "" → uncategorised; collapses the category bar if none have one
  meta: string;     // shown in detail view (path / id); may be ""
}

interface BrowserConfig {
  title: string;          // e.g. "Skill Browser"
  unit: string;           // pluralised noun for the count, e.g. "skills"
  entries: Entry[];
  categoryOrder?: string[]; // optional explicit ordering of categories
  categoryIcons?: Record<string, string>; // optional glyph per category
}

// ════════════════════════════════════════════════════════════════════════════
// LOADERS — one per command. Each is total: never throws, returns [] on failure.
// ════════════════════════════════════════════════════════════════════════════

// ── /skills : packaged skills (file scan) ────────────────────────────────────

const SKILL_CATEGORY_MAP: Record<string, string> = {
  "using-superpowers": "Workflow",
  "brainstorming": "Workflow",
  "writing-plans": "Workflow",
  "verification-before-completion": "Workflow",
  "test-driven-development": "Implementation",
  "executing-plans": "Implementation",
  "subagent-driven-development": "Implementation",
  "dispatching-parallel-agents": "Implementation",
  "systematic-debugging": "Quality",
  "requesting-code-review": "Quality",
  "receiving-code-review": "Quality",
  "using-git-worktrees": "Project",
  "finishing-a-development-branch": "Project",
  "huashu-design": "Design",
  "csv-export": "Utilities",
  "retry-backoff": "Utilities",
  "writing-skills": "Meta",
};

const SKILL_CATEGORY_ORDER = ["all", "Workflow", "Implementation", "Quality", "Project", "Design", "Utilities", "Meta"];
const SKILL_CATEGORY_ICONS: Record<string, string> = {
  Workflow: "☰", Implementation: "⚙", Quality: "✓", Project: "⬡",
  Design: "⬢", Utilities: "⚡", Meta: "◎",
};

function parseFrontmatter(content: string): { name: string; description: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { name: "", description: "" };
  const yaml = m[1]!;
  const nm = yaml.match(/^name:\s*(.+)$/m);
  const dm = yaml.match(/^description:\s*(.+)$/m);
  return { name: nm?.[1]?.trim() ?? "", description: dm?.[1]?.trim() ?? "" };
}

function loadSkills(): Entry[] {
  const dir = path.join(os.homedir(), ".pi", "skills");
  const out: Entry[] = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const { name, description } = parseFrontmatter(fs.readFileSync(skillPath, "utf-8"));
      out.push({
        name: name || entry.name,
        description,
        category: SKILL_CATEGORY_MAP[entry.name] ?? "Other",
        meta: skillPath,
      });
    }
  } catch { /* fail-open: show whatever we managed to read */ }
  return out;
}

// ── /tools : native PI tools (capability-index DB) ───────────────────────────
// Reads the rows pi-capability-index harvests from pi.getAllTools() at
// session_start. id is `tool:pi:<name>`, kind = "tool". Tools have no natural
// grouping, so we leave `category` empty → the category bar collapses away.

function capIndexDbPath(): string {
  return path.join(os.homedir(), ".pi", "capabilities", "index.db");
}

function loadTools(): Entry[] {
  const file = capIndexDbPath();
  if (!fs.existsSync(file)) return []; // index not built yet → empty state
  let db: ReturnType<typeof openCapDb> | undefined;
  try {
    db = openCapDb(file);
    const rows = db
      .prepare("SELECT name, summary, id FROM capability WHERE kind = 'tool' ORDER BY name")
      .all() as Array<{ name: string; summary: string; id: string }>;
    return rows.map((r) => ({
      name: r.name,
      description: r.summary ?? "",
      category: "",
      meta: r.id,
    }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ── /docs : knowledge-library docs (markdown files) ───────────────────────────
// The library is files-only now (semble does the searching); read frontmatter
// from kb/collections/<id>/docs/*.md directly. Category = collection id.

function loadDocs(): Entry[] {
  const root = path.join(os.homedir(), ".pi", "kb", "collections");
  if (!fs.existsSync(root)) return []; // no library yet → empty state
  const out: Entry[] = [];
  let cols: string[] = [];
  try { cols = fs.readdirSync(root); } catch { return []; }
  for (const col of cols) {
    const docsDir = path.join(root, col, "docs");
    let files: string[] = [];
    try { files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      let text = "";
      try { text = fs.readFileSync(path.join(docsDir, f), "utf-8"); } catch { continue; }
      const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      const title = (/^title:\s*(.+)$/m.exec(block)?.[1] ?? f.replace(/\.md$/, "")).trim();
      const description = (/^description:\s*(.+)$/m.exec(block)?.[1] ?? "").trim();
      out.push({ name: title || "(untitled)", description, category: col, meta: path.join(docsDir, f) });
    }
  }
  out.sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// PURE LOGIC — exported for testing / reuse, no I/O, no TUI.
// ════════════════════════════════════════════════════════════════════════════

/** Distinct non-empty categories, prefixed with "all". Honours `explicitOrder`
 *  (intersected with what's present) and otherwise sorts alphabetically. */
export function deriveCategories(entries: Entry[], explicitOrder?: string[]): string[] {
  const present = new Set(entries.map((e) => e.category).filter((c) => c.length > 0));
  if (present.size === 0) return ["all"]; // → bar hides itself
  const ordered = explicitOrder
    ? explicitOrder.filter((c) => c === "all" || present.has(c))
    : ["all", ...[...present].sort((a, b) => a.localeCompare(b))];
  return ordered.includes("all") ? ordered : ["all", ...ordered];
}

/** Filter by active category then case-insensitive substring over name/desc/category. */
export function filterEntries(entries: Entry[], query: string, activeCategory: string): Entry[] {
  let items = entries;
  if (activeCategory !== "all") items = items.filter((e) => e.category === activeCategory);
  if (query) {
    const q = query.toLowerCase();
    items = items.filter((e) =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q));
  }
  return items;
}

/** Greedy word-wrap for the detail panel. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if (visibleWidth(cur) + 1 + visibleWidth(w) <= width) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// ════════════════════════════════════════════════════════════════════════════
// TUI OVERLAY — generic over `Entry[]`. Reused by all three commands.
// ════════════════════════════════════════════════════════════════════════════

class EntryBrowser {
  private entries: Entry[];
  private filtered: Entry[] = [];
  private categories: string[];
  private catIcons: Record<string, string>;
  private query = "";
  private activeCategory = "all";
  private cursor = 0;
  private page = 0;
  private pageSize = 10;
  private detail = false; // Enter toggles a full-text detail panel for the selected row

  // render cache
  private _w?: number;
  private _lines?: string[];
  private _hash?: string;

  constructor(
    private theme: Theme,
    private cfg: BrowserConfig,
    private done: (v: void) => void,
  ) {
    this.entries = cfg.entries;
    this.categories = deriveCategories(this.entries, cfg.categoryOrder);
    this.catIcons = cfg.categoryIcons ?? {};
    this.apply();
  }

  private get showCategories(): boolean {
    return this.categories.filter((c) => c !== "all").length > 0;
  }

  // ── filter ──
  private apply() {
    this.filtered = filterEntries(this.entries, this.query, this.activeCategory);
    this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
    this.page = 0;
  }

  private hash() {
    return `${this.activeCategory}|${this.query}|${this.cursor}|${this.page}|${this.filtered.length}|${this.detail}`;
  }

  // ── input ──
  handleInput(data: string): void {
    // Detail panel: any of Esc/Enter/Backspace returns to the list.
    if (this.detail) {
      if (matchesKey(data, Key.escape) || data === "\r" || data === "\n"
          || data === "\x7f" || matchesKey(data, Key.backspace)) {
        this.detail = false; this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.escape)) return this.done(undefined);

    // Enter → open detail for the highlighted entry (read-only; no agent action).
    if (data === "\r" || data === "\n") {
      if (this.filtered[this.cursor]) { this.detail = true; this.invalidate(); }
      return;
    }

    if (matchesKey(data, Key.up))   { if (this.cursor > 0) this.cursor--; this.syncPage(); this.invalidate(); return; }
    if (matchesKey(data, Key.down)) { if (this.cursor < this.filtered.length - 1) this.cursor++; this.syncPage(); this.invalidate(); return; }
    if (matchesKey(data, Key.home)) { this.cursor = 0; this.page = 0; this.invalidate(); return; }
    if (matchesKey(data, Key.end))  { this.cursor = this.filtered.length - 1; this.page = this.lastPage(); this.invalidate(); return; }
    if (matchesKey(data, Key.pageUp))   { this.page = Math.max(0, this.page - 1); this.cursor = this.page * this.pageSize; this.invalidate(); return; }
    if (matchesKey(data, Key.pageDown)) { this.page = Math.min(this.lastPage(), this.page + 1); this.cursor = this.page * this.pageSize; this.invalidate(); return; }

    // Tab cycles categories (no-op when the dataset has none).
    if (matchesKey(data, Key.tab)) {
      if (!this.showCategories) return;
      const i = this.categories.indexOf(this.activeCategory);
      this.activeCategory = this.categories[(i + 1) % this.categories.length]!;
      this.apply(); this.invalidate();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) { this.query = ""; this.apply(); this.invalidate(); return; }
    if (data === "\x7f" || matchesKey(data, Key.backspace)) { this.query = this.query.slice(0, -1); this.apply(); this.invalidate(); return; }
    if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) { this.query += data; this.apply(); this.invalidate(); return; }
  }

  private lastPage() { return Math.max(0, Math.ceil(this.filtered.length / this.pageSize) - 1); }
  private syncPage() { this.page = Math.floor(this.cursor / this.pageSize); }

  // ── render ──
  render(width: number): string[] {
    const h = this.hash();
    if (this._lines && this._w === width && this._hash === h) return this._lines;
    const lines = this.detail ? this.renderDetail(width) : this.renderList(width);
    this._w = width; this._hash = h;
    return (this._lines = lines);
  }

  private chrome(width: number) {
    const t = this.theme;
    const W = Math.max(44, Math.min(width - 4, 96));
    const pad = Math.max(0, Math.floor((width - W) / 2));
    return {
      t, W, IW: W - 2,
      P: (s: string) => " ".repeat(pad) + s,
      a: (s: string) => t.fg("accent", s),
      mu: (s: string) => t.fg("muted", s),
      di: (s: string) => t.fg("dim", s),
      se: (s: string) => t.fg("success", s),
      wa: (s: string) => t.fg("warning", s),
      bo: (s: string) => t.fg("borderAccent", s),
    };
  }

  private renderList(width: number): string[] {
    const { t, IW, P, a, mu, di, se, wa, bo } = this.chrome(width);
    const lines: string[] = [];

    lines.push(P(bo("╭" + "─".repeat(IW) + "╮")));

    const title = ` ${this.cfg.title}  ·  ${this.entries.length} ${this.cfg.unit}`;
    lines.push(P(bo("│") + a(t.bold(title)) + " ".repeat(Math.max(0, IW - visibleWidth(title))) + bo("│")));
    lines.push(P(bo("├") + di("─".repeat(IW)) + bo("┤")));

    // search
    const prompt = "Find: ";
    const avail = IW - visibleWidth(prompt);
    const qdisp = this.query
      ? this.query.length > avail ? "…" + this.query.slice(-(avail - 1)) : this.query
      : "";
    const placeholder = this.query ? "" : di("type to filter…");
    const searchLine = mu(prompt) + se(qdisp) + placeholder;
    lines.push(P(bo("│") + searchLine + " ".repeat(Math.max(0, IW - visibleWidth(searchLine))) + bo("│")));

    // categories (only when the dataset has them)
    if (this.showCategories) {
      let catLine = "";
      for (const c of this.categories) {
        const icon = this.catIcons[c] ?? "";
        const label = (icon ? icon + " " : "") + c;
        catLine += c === this.activeCategory ? " " + se("[" + label + "]") : " " + mu(label);
      }
      catLine += "  " + di("tab");
      lines.push(P(bo("│") + catLine + " ".repeat(Math.max(0, IW - visibleWidth(catLine))) + bo("│")));
    }

    lines.push(P(bo("├") + di("─".repeat(IW)) + bo("┤")));

    // list
    const start = this.page * this.pageSize;
    const pageItems = this.filtered.slice(start, start + this.pageSize);
    const nameW = Math.min(26, Math.floor(IW * 0.44));

    if (this.filtered.length === 0) {
      const empty = this.entries.length === 0
        ? `  (nothing indexed yet for ${this.cfg.unit})`
        : "  (no matches)";
      lines.push(P(bo("│") + di(empty) + " ".repeat(Math.max(0, IW - visibleWidth(empty))) + bo("│")));
      for (let i = 1; i < this.pageSize; i++) lines.push(P(bo("│") + " ".repeat(IW) + bo("│")));
    } else {
      for (let i = 0; i < this.pageSize; i++) {
        const item = pageItems[i];
        if (!item) { lines.push(P(bo("│") + " ".repeat(IW) + bo("│"))); continue; }
        const isSel = start + i === this.cursor;
        const icon = this.catIcons[item.category] ?? "·";
        const name = item.name.length > nameW ? item.name.slice(0, nameW - 1) + "…" : item.name;
        const descAvail = IW - nameW - 6;
        const desc = (item.description || "").length > descAvail
          ? item.description.slice(0, descAvail - 1) + "…" : item.description || "";
        const plainName = name.padEnd(nameW);
        const plainDesc = (desc || "").padEnd(Math.max(0, descAvail));
        const bullet = isSel ? wa("▶") : " ";
        const iconStr = isSel ? se(icon) : mu(icon);
        const nameStr = isSel ? a(t.bold(plainName)) : plainName;
        const descStr = isSel ? plainDesc : mu(plainDesc);
        lines.push(P(bo("│") + " " + bullet + " " + iconStr + " " + nameStr + " " + descStr + bo("│")));
      }
    }

    // footer
    lines.push(P(bo("├") + di("─".repeat(IW)) + bo("┤")));
    const totalPages = Math.max(1, Math.ceil(this.filtered.length / this.pageSize));
    const left = ` Pg ${this.page + 1}/${totalPages}`;
    const mid = `${this.filtered.length} match`;
    const right = `esc  ↵ detail  ↑↓  pgup/pgdn` + (this.showCategories ? "  tab" : "");
    const gap = Math.max(2, IW - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right) - 8);
    const footer = left + "  ·  " + mid + "  ".repeat(gap) + right;
    lines.push(P(bo("│") + di(footer) + " ".repeat(Math.max(0, IW - visibleWidth(footer))) + bo("│")));
    lines.push(P(bo("╰" + "─".repeat(IW) + "╯")));
    return lines;
  }

  // Read-only detail panel: full (untruncated) description + meta line.
  private renderDetail(width: number): string[] {
    const { t, IW, P, a, mu, di, se, bo } = this.chrome(width);
    const item = this.filtered[this.cursor]!;
    const lines: string[] = [];

    lines.push(P(bo("╭" + "─".repeat(IW) + "╮")));
    const name = " " + item.name;
    lines.push(P(bo("│") + a(t.bold(name)) + " ".repeat(Math.max(0, IW - visibleWidth(name))) + bo("│")));
    if (item.category) {
      const cat = "  " + (this.catIcons[item.category] ?? "·") + " " + item.category;
      lines.push(P(bo("│") + se(cat) + " ".repeat(Math.max(0, IW - visibleWidth(cat))) + bo("│")));
    }
    lines.push(P(bo("├") + di("─".repeat(IW)) + bo("┤")));

    for (const ln of wrapText(item.description || "(no description)", IW - 2)) {
      const s = " " + ln;
      lines.push(P(bo("│") + mu(s) + " ".repeat(Math.max(0, IW - visibleWidth(s))) + bo("│")));
    }

    if (item.meta) {
      lines.push(P(bo("│") + " ".repeat(IW) + bo("│")));
      for (const ln of wrapText(item.meta, IW - 2)) {
        const s = " " + ln;
        lines.push(P(bo("│") + di(s) + " ".repeat(Math.max(0, IW - visibleWidth(s))) + bo("│")));
      }
    }

    lines.push(P(bo("├") + di("─".repeat(IW)) + bo("┤")));
    const hint = " esc / ↵  back to list";
    lines.push(P(bo("│") + di(hint) + " ".repeat(Math.max(0, IW - visibleWidth(hint))) + bo("│")));
    lines.push(P(bo("╰" + "─".repeat(IW) + "╯")));
    return lines;
  }

  invalidate(): void { this._w = undefined; this._lines = undefined; this._hash = undefined; }
}

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION ENTRY — register the three commands.
// ════════════════════════════════════════════════════════════════════════════

function openBrowser(ctx: any, cfg: BrowserConfig): Promise<void> {
  return ctx.ui.custom<void>(
    (_tui: any, theme: Theme, _kb: any, done: (v: void) => void) => new EntryBrowser(theme, cfg, done),
    { overlay: true, overlayOptions: { anchor: "center", width: "82%", maxHeight: "88%", margin: 1 } },
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("skills", {
    description: "Browse packaged skills with search, categories, and pagination",
    handler: (_args: string, ctx: any) =>
      openBrowser(ctx, {
        title: "Skill Browser",
        unit: "skills",
        entries: loadSkills(),
        categoryOrder: SKILL_CATEGORY_ORDER,
        categoryIcons: SKILL_CATEGORY_ICONS,
      }),
  });

  pi.registerCommand("tools", {
    description: "Browse native PI tools indexed by pi-capability-index",
    handler: (_args: string, ctx: any) =>
      openBrowser(ctx, { title: "Tool Browser", unit: "tools", entries: loadTools() }),
  });

  pi.registerCommand("docs", {
    description: "Browse research-library docs indexed by pi-research-library",
    handler: (_args: string, ctx: any) =>
      openBrowser(ctx, { title: "Doc Browser", unit: "docs", entries: loadDocs() }),
  });
}

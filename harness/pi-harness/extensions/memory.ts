/**
 * memory — always-on 1-liner long-term memory injected into the loadout.
 *
 * A dependency-free flat extension (like notify.ts / startup-logo.ts). It keeps
 * a plain hand-editable file of one-line facts and injects them into the system
 * prompt every turn via `before_agent_start`. This is the unbuilt
 * `pi-hermes-memory` sibling the context-management spec anticipated, kept
 * minimal as a single file.
 *
 *   • Store:   ~/.pi/agent/memory.md  — one memory per line, hand-editable.
 *              Blank lines and lines starting with `#` are ignored (headings).
 *              Lives OUTSIDE the kb/ index — never searched, only injected.
 *   • Inject:  appends a <memory> block to the system prompt. Budget ~500 tok
 *              (~2000 chars); over budget keeps the NEWEST lines (file tail = FIFO)
 *              and prepends a trimmed marker.
 *   • Write:   `remember` tool (agent-callable, enforces the 1-liner rule) and
 *              `/remember <text>` command (you). The file is the source of truth.
 *
 * Memory ≠ KB: durable preferences/conventions/lessons go here; sourced,
 * searchable reference knowledge goes to the Knowledge Library (kb_* tools).
 *
 * Config (env):
 *   MEMORY_DISABLE        — register nothing (kill switch)
 *   MEMORY_BUDGET_CHARS   — injection budget in chars (default 2000 ≈ 500 tok)
 *
 * Invariant: fail-open. Any error injects nothing and never corrupts a request.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Flat extension: typebox resolves from agent/extensions/node_modules (same as
// code-vocab-wire.ts), so a bare import works without reaching into a sibling.
import { Type } from "typebox";

const MEMORY_FILE = path.join(os.homedir(), ".pi", "agent", "memory.md");
const MAX_LINE = 120;
const DEFAULT_BUDGET = 2000;

/** Non-empty, non-comment memory lines in file order (oldest → newest). */
function readLines(): string[] {
  try {
    return fs
      .readFileSync(MEMORY_FILE, "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** The 1-liner rule: collapse whitespace/newlines, trim, cap length. */
function normalize(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_LINE ? one.slice(0, MAX_LINE - 1) + "…" : one;
}

type AppendResult = "saved" | "duplicate" | "empty";

/** Append a normalized 1-liner; dedupe case-insensitively. */
function append(text: string): AppendResult {
  const line = normalize(text);
  if (!line) return "empty";
  if (readLines().some((l) => l.toLowerCase() === line.toLowerCase())) return "duplicate";
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  } catch {
    /* dir may already exist */
  }
  let cur = "";
  try {
    cur = fs.readFileSync(MEMORY_FILE, "utf-8");
  } catch {
    /* new file */
  }
  const sep = cur.length && !cur.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(MEMORY_FILE, sep + line + "\n", "utf-8");
  return "saved";
}

/** Build the <memory> block, keeping the newest lines within `budget` chars. */
function buildBlock(budget: number): string {
  const lines = readLines();
  if (!lines.length) return "";
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i]!.length + 3; // "- " + "\n"
    if (kept.length && total + cost > budget) break;
    kept.unshift(lines[i]!);
    total += cost;
  }
  const trimmed = kept.length < lines.length ? "- …(older memories trimmed)\n" : "";
  const body = kept.map((l) => `- ${l}`).join("\n");
  return (
    "<memory>\n" +
    "Durable facts you (the agent) have saved. Treat as background; verify before relying on anything that may be stale. To save a new durable 1-liner, call the `remember` tool.\n" +
    trimmed +
    body +
    "\n</memory>"
  );
}

export default function (pi: ExtensionAPI) {
  if (process.env["MEMORY_DISABLE"]) return;
  const budget = Number(process.env["MEMORY_BUDGET_CHARS"] ?? DEFAULT_BUDGET);

  pi.on("before_agent_start", async (event: any) => {
    try {
      const block = buildBlock(budget);
      if (!block) return;
      return { systemPrompt: event.systemPrompt + "\n\n" + block };
    } catch {
      return; // fail-open
    }
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Save a durable one-line fact to long-term memory (injected into every future system prompt). Use for stable user preferences, project conventions, or hard-won lessons — NOT transient task state. Keep it to a single concise line.",
    promptSnippet: "save a durable 1-line fact to long-term memory",
    parameters: Type.Object({
      text: Type.String({ description: "The single-line fact to remember." }),
    }),
    async execute(_id: string, p: any) {
      const r = append(String(p?.text ?? ""));
      const msg =
        r === "saved"
          ? "Remembered."
          : r === "duplicate"
            ? "Already remembered (no change)."
            : "Nothing to remember (empty input).";
      return { content: [{ type: "text" as const, text: msg }], details: {} };
    },
  } as any);

  pi.registerCommand("remember", {
    description: "Save a one-line fact to long-term memory (no args → show memory status)",
    handler: async (args: string, c: any) => {
      if (!args || !args.trim()) {
        if (c?.hasUI) c.ui.notify(`memory · ${readLines().length} line(s) · ${MEMORY_FILE}`, "info");
        return;
      }
      const r = append(args);
      if (!c?.hasUI) return;
      if (r === "saved") c.ui.notify("Remembered.", "info");
      else if (r === "duplicate") c.ui.notify("Already remembered (no change).", "warning");
      else c.ui.notify("Nothing to remember (empty input).", "warning");
    },
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Mode definitions ──────────────────────────────────────────────
const MODES = ["off", "lite", "full", "ultra"] as const;
type Mode = (typeof MODES)[number];
const DEFAULT_MODE: Mode = "full";

function normalizeMode(raw: string): Mode | null {
  const n = raw.trim().toLowerCase();
  return MODES.includes(n as Mode) ? (n as Mode) : null;
}

// ── The ladder (shared, intensity-invariant) ───────────────────────
const LADDER = `## The ladder

Before writing any code, stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need = skip it, say so in one line. (YAGNI)
2. **Stdlib does it?** Use it.
3. **Native platform feature covers it?** \`<input type="date">\` over a picker lib, CSS over JS, DB constraint over app code.
4. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do.
5. **Can it be one line?** One line.
6. **Only then:** the minimum code that works.

The ladder is a reflex, not a research project. Two rungs work → take the higher one and move on.`;

// ── Rules (shared) ─────────────────────────────────────────────────
const RULES = `## Rules

- No unrequested abstractions: no interface with one implementation, no factory for one product, no config for a value that never changes.
- No boilerplate, no scaffolding "for later". Later can scaffold for itself.
- Deletion over addition. Boring over clever.
- Fewest files possible. Shortest working diff wins.
- Complex request? Ship the lazy version and question it in the same response. Never stall on an answer you can default.
- Two stdlib options, same size? Take the one that's correct on edge cases. Lazy means writing less code, not picking the flimsier algorithm.
- Mark deliberate simplifications with a \`ponytail:\` comment (\`// ponytail: this exists\`). Shortcut with a known ceiling (global lock, O(n²) scan)? The comment names the ceiling and the upgrade path.`;

// ── Safety boundary (shared) ──────────────────────────────────────
const SAFETY = `## When NOT to be lazy

Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security measures, accessibility basics, anything explicitly requested. User insists on the full version → build it, no re-arguing.

Lazy code without its check is unfinished. Non-trivial logic (a branch, a loop, a parser, a money/security path) leaves ONE runnable check behind — the smallest thing that fails if the logic breaks: an \`assert\`-based \`demo()\` self-check or one small \`test_*.py\`. No frameworks, no fixtures. Trivial one-liners need no test.`;

// ── Output rule ───────────────────────────────────────────────────
const OUTPUT = `## Output

Code first. Then at most three short lines: what was skipped, when to add it. If the explanation is longer than the code, delete the explanation. Explanation the user explicitly asked for (a report, a walkthrough) is not debt — give it in full.`;

// ── Intensity-specific blocks ─────────────────────────────────────
const INTENSITY: Record<Exclude<Mode, "off">, string> = {
  lite: `## Intensity: lite
Build what's asked, but name the lazier alternative in one line. User picks.
Example: "Done, cache added. FYI: \`functools.lru_cache\` covers this in one line if you'd rather not own a cache class."`,

  full: `## Intensity: full (default)
The ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.
Example: "\`@lru_cache(maxsize=1000)\` on the fetch function. Skipped custom cache class, add when lru_cache measurably falls short."`,

  ultra: `## Intensity: ultra
YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same breath.
Example: "No cache until a profiler says so. When it does: \`@lru_cache\`. A hand-rolled TTL cache class is a bug farm with a hit rate."`,
};

// ── Build full prompt for a mode ──────────────────────────────────
function buildInstructions(mode: Mode): string {
  const body = INTENSITY[mode as Exclude<Mode, "off">] ?? INTENSITY.full;
  return [
    "PONYTAIL MODE ACTIVE — level: " + mode,
    "",
    "You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.",
    "",
    "## Persistence",
    "ACTIVE EVERY RESPONSE. No drift back to over-building. Still active if unsure. Off only: \"stop ponytail\" / \"normal mode\".",
    "",
    LADDER,
    "",
    RULES,
    "",
    OUTPUT,
    "",
    body,
    "",
    SAFETY,
    "",
    "## Boundaries",
    "Ponytail governs what you build, not how you talk. \"stop ponytail\" or \"normal mode\": revert. Level persists until changed or session end.",
  ].join("\n");
}

// ── Help card ─────────────────────────────────────────────────────
const HELP = `## Ponytail Lite Help

| Level | Trigger | What change |
|-------|---------|-------------|
| **lite** | \`/ponytail-lite lite\` | Build what's asked, name the lazier alternative. |
| **full** | \`/ponytail-lite full\` | Ladder enforced: YAGNI → stdlib → native → one line → minimum. Default. |
| **ultra** | \`/ponytail-lite ultra\` | YAGNI extremist. Deletion before addition. Challenge requirements. |
| **off** | \`/ponytail-lite off\` | Disable. |

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **review** | \`/ponytail-lite-review\` | Diff review for over-engineering. One line per finding. |
| **audit** | \`/ponytail-lite-audit\` | Whole-repo over-engineering scan, ranked. |
| **help** | \`/ponytail-lite-help\` | This card. |

Deactivate: say "stop ponytail" or "normal mode". Resume: \`/ponytail-lite full\`.`;

// ── Extension ─────────────────────────────────────────────────────
export default function ponytailLiteExtension(pi: ExtensionAPI) {
  let currentMode: Mode = DEFAULT_MODE;

  // ── Session start: check for persisted mode ─────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const entries: any[] =
      (ctx as any)?.session?.getEntries?.() ||
      (ctx as any)?.sessionManager?.getEntries?.() ||
      (ctx as any)?.sessionManager?.getBranch?.() ||
      [];
    // Walk backwards for the last ponytail-mode entry
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "custom" && e?.customType === "ponytail-lite-mode") {
        const m = normalizeMode(e?.data?.mode ?? "");
        if (m) { currentMode = m; return; }
      }
    }
    // No persisted entry — keep default
  });

  // ── Inject system prompt before every agent turn ─────────────────
  pi.on("before_agent_start", async (event: any) => {
    if (!currentMode || currentMode === "off") return;
    return {
      systemPrompt: `${event.systemPrompt || ""}\n\n${buildInstructions(currentMode)}`,
    };
  });

  // ── Listen for deactivation phrases ──────────────────────────────
  pi.on("input", async (event: any) => {
    if (event?.source === "extension") return;
    const t = String(event?.text || "").trim().toLowerCase().replace(/[.!?\s]+$/, "");
    if (t === "stop ponytail" || t === "normal mode") {
      currentMode = "off";
    }
  });

  // ── /ponytail-lite ───────────────────────────────────────────────
  pi.registerCommand("ponytail-lite", {
    description: "Set ponytail intensity (lite | full | ultra | off) or show status",
    handler: async (args: string, ctx: any) => {
      const raw = String(args || "").trim().toLowerCase();
      if (!raw) {
        ctx?.ui?.notify?.(`Ponytail Lite: ${currentMode}`, "info");
        return;
      }
      if (raw === "status") {
        ctx?.ui?.notify?.(`Ponytail Lite: ${currentMode}`, "info");
        return;
      }
      const mode = normalizeMode(raw);
      if (!mode) {
        ctx?.ui?.notify?.(`Unknown mode "${raw}". Use: lite | full | ultra | off`, "warning");
        return;
      }
      currentMode = mode;
      pi.appendEntry("ponytail-lite-mode", { mode });
      ctx?.ui?.notify?.(`Ponytail Lite set to ${mode}.`, "info");
    },
  });

  // ── /ponytail-lite-review ───────────────────────────────────────
  pi.registerCommand("ponytail-lite-review", {
    description: "Review current diff for over-engineering",
    handler: async (_args: string, ctx: any) => {
      pi.sendUserMessage("/skill:ponytail-lite-review");
      ctx?.ui?.notify?.("ponytail-lite-review queued.", "info");
    },
  });

  // ── /ponytail-lite-audit ────────────────────────────────────────
  pi.registerCommand("ponytail-lite-audit", {
    description: "Audit whole repo for over-engineering",
    handler: async (_args: string, ctx: any) => {
      pi.sendUserMessage("/skill:ponytail-lite-audit");
      ctx?.ui?.notify?.("ponytail-lite-audit queued.", "info");
    },
  });


  // ── /ponytail-lite-help ─────────────────────────────────────────
  pi.registerCommand("ponytail-lite-help", {
    description: "Show ponytail-lite help card",
    handler: async (_args: string, ctx: any) => {
      pi.sendUserMessage("/skill:ponytail-lite-help");
      ctx?.ui?.notify?.("ponytail-lite-help queued.", "info");
    },
  });
}

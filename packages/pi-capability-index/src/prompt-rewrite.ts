import type { Capability } from "./types.js";

const OPEN = "<available_skills>";
const CLOSE = "</available_skills>";

const POINTER = "# More skills available — call capability_search to find them by task.";

function filePathOf(s: Capability): string {
  return (s.activation as { filePath?: string })?.filePath ?? "";
}

/** One line, no embedded newlines (descriptions can be multi-line). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * If every skill lives at `<root><sep><name><sep>SKILL.md` for one shared root
 * and separator, return that {root, sep} so the path can be stated once instead
 * of repeated per skill. Otherwise null (paths are stated inline).
 */
function uniformRoot(skills: Capability[]): { root: string; sep: string } | null {
  let root: string | null = null;
  let sep = "/";
  for (const s of skills) {
    const loc = filePathOf(s);
    if (!loc) return null;
    const usep = loc.includes("\\") ? "\\" : "/";
    const tail = `${usep}${s.name}${usep}SKILL.md`;
    if (!loc.endsWith(tail)) return null;
    const r = loc.slice(0, loc.length - tail.length);
    if (root === null) { root = r; sep = usep; }
    else if (r !== root || usep !== sep) return null;
  }
  return root === null ? null : { root, sep };
}

export function renderBlock(skills: Capability[]): string {
  const lines = [OPEN];
  const uniform = skills.length > 0 ? uniformRoot(skills) : null;
  if (uniform) {
    lines.push(`# Load a skill by reading ${uniform.root}${uniform.sep}{name}${uniform.sep}SKILL.md`);
    for (const s of skills) lines.push(`- ${s.name}: ${oneLine(s.summary)}`);
  } else {
    for (const s of skills) {
      const loc = filePathOf(s);
      const desc = oneLine(s.summary);
      lines.push(loc ? `- ${s.name}: ${desc} — ${loc}` : `- ${s.name}: ${desc}`);
    }
  }
  lines.push(POINTER);
  lines.push(CLOSE);
  return lines.join("\n");
}

export function slimSkillsBlock(prompt: string, active: Capability[]): string {
  const start = prompt.indexOf(OPEN);
  const end = prompt.indexOf(CLOSE);
  if (start === -1 || end === -1 || end < start) return prompt; // fail open
  const before = prompt.slice(0, start);
  const after = prompt.slice(end + CLOSE.length);
  return before + renderBlock(active) + after;
}

export type PolicyStyle = "full" | "compact" | "none";

export function capPolicy(style: PolicyStyle): string {
  if (style === "none") return "";
  const compact = `<capability-policy>
Before acting on any non-trivial task, FIRST consider whether a skill applies — do not wing a task a skill exists for. Only your active loadout's skills are shown above; many more skills/tools exist but are unlisted to save context. If none shown fits, call capability_search(query, { kind? }) to find one BEFORE improvising, then capability_activate(id) to load it (available next turn). Search 'all' kinds by default, or pass kind:'skill'|'tool'|'mcp' to scope.
</capability-policy>`;
  if (style === "compact") return compact;
  return compact.replace("</capability-policy>",
    `Frequently-used capabilities are auto-promoted into your active set; pin one permanently with /loadout promote <id>.
</capability-policy>`);
}

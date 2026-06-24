export function classifyDiscovery(toolName: string, input: any): { hit: boolean; hint: string } {
  // Only flag *discovery* — "where does X live?" — not targeted reads of a path the
  // model already named. Reading a known file (read / cat / head / tail) is deliberate,
  // so it is never nudged; grep/find/ls-style scanning is.
  const inNM = (s?: string) => !!s && s.includes("node_modules");
  if (toolName === "grep") {
    if (input?.query && !inNM(input?.path)) return { hit: true, hint: `grep "${input.query}"` };
  } else if (toolName === "find") {
    if (input?.pattern && !inNM(input?.path)) return { hit: true, hint: `find ${input.pattern}` };
  } else if (toolName === "bash") {
    const cmd = String(input?.command ?? "").trim();
    if (/^(?:grep|rg|ag|find|ls)\b/.test(cmd) && !cmd.includes("node_modules") && !cmd.includes("package.json")) {
      return { hit: true, hint: cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd };
    }
  }
  return { hit: false, hint: "" };
}

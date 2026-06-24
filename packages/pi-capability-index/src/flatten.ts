const CAP = 200; // per-field truncation to bound size

export function flattenParams(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "";
  const parts: string[] = [];
  walk(schema as Record<string, unknown>, "", parts);
  return parts.join(" ").slice(0, 4000).trim();
}

function walk(node: Record<string, unknown>, prefix: string, out: string[]): void {
  const props = node["properties"];
  if (props && typeof props === "object") {
    for (const [key, val] of Object.entries(props as Record<string, unknown>)) {
      const v = (val ?? {}) as Record<string, unknown>;
      const fieldName = prefix ? `${prefix}.${key}` : key;
      let line = fieldName;
      if (typeof v["description"] === "string") line += `: ${(v["description"] as string).slice(0, CAP)}`;
      if (Array.isArray(v["enum"])) line += ` (enum: ${(v["enum"] as unknown[]).join("|")})`;
      out.push(line);
      if (v["properties"]) walk(v, fieldName, out);
    }
  }
}

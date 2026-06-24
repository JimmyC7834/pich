import fs from "node:fs";
import path from "node:path";

export function safeReadFile(
  rawPath: string, roots: string[],
): { ok: true; content: string } | { ok: false; error: string } {
  let real: string;
  try { real = fs.realpathSync(path.resolve(rawPath)); }
  catch { return { ok: false, error: "path does not exist" }; }
  const inRoot = roots.some((r) => {
    const root = path.resolve(r);
    const rel = path.relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!inRoot) return { ok: false, error: "path outside allowed roots" };
  try { return { ok: true, content: fs.readFileSync(real, "utf-8") }; }
  catch { return { ok: false, error: "read failed" }; }
}

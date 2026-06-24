import path from "node:path";

/** Append-only JSONL file holding one usage row per assistant turn.
 *
 *  Lives under the project-local artifacts dir `<cwd>/.pi/usage/` — the same
 *  gitignored `.pi/` tree sibling extensions use (code-vocab, deepseek-compact,
 *  toolcall-guard) — so telemetry is never committed. Override with
 *  USAGE_RECORDER_FILE (e.g. for tests). */
export function usageFile(): string {
  return process.env["USAGE_RECORDER_FILE"] ?? path.join(process.cwd(), ".pi", "usage", "usage.jsonl");
}

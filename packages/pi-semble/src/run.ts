import { spawn } from "node:child_process";
export interface RunResult { code: number | null; stdout: string; stderr: string; }
export function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", proc;
    try { proc = spawn(cmd, args, { cwd, env: env ?? process.env, signal }); }
    catch (e: any) { resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) }); return; }
    proc.stdout?.on("data", (d) => (stdout += d.toString("utf-8")));
    proc.stderr?.on("data", (d) => (stderr += d.toString("utf-8")));
    proc.on("error", (e: any) => resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e) }));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

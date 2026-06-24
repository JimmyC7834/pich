import { execFile } from "node:child_process";
import type { BridgeEntry } from "./registry";

/** A VS Code terminal paired with its shell process id (and optional injected marker). */
export interface TerminalRef<T> {
  terminal: T;
  shellPid: number;
  marker?: string;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

/** Build a child-pid → parent-pid map for the whole machine. */
export async function buildParentMap(): Promise<Map<number, number>> {
  const map = new Map<number, number>();

  if (process.platform === "win32") {
    const out = await exec("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ]);
    try {
      const parsed = JSON.parse(out);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of arr) {
        const pid = Number(p.ProcessId);
        const ppid = Number(p.ParentProcessId);
        if (pid) map.set(pid, ppid || 0);
      }
    } catch {}
  } else {
    const out = await exec("ps", ["-axo", "pid=,ppid="]);
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) map.set(Number(m[1]), Number(m[2]));
    }
  }

  return map;
}

/** Walk the parent chain from `pid` to see if `ancestor` appears in it. */
export function isDescendantOf(pid: number, ancestor: number, parentMap: Map<number, number>, maxDepth = 50): boolean {
  let cur = pid;
  for (let i = 0; i < maxDepth; i++) {
    if (cur === ancestor) return true;
    const parent = parentMap.get(cur);
    if (parent === undefined || parent === 0 || parent === cur) break;
    cur = parent;
  }
  return false;
}

/**
 * Map each live bridge session to the VS Code terminal it runs in.
 * 1. Terminals created by the extension carry a unique marker (env var) — exact match.
 * 2. Hand-launched pi is matched by process-tree ancestry (pi's pid descends from the shell).
 */
export async function correlate<T>(
  entries: BridgeEntry[],
  terminals: TerminalRef<T>[],
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  const unmatched: BridgeEntry[] = [];

  // Pass 1 — marker match.
  for (const entry of entries) {
    const byMarker = entry.terminalMarker
      ? terminals.find((t) => t.marker && t.marker === entry.terminalMarker)
      : undefined;
    if (byMarker) result.set(entry.key, byMarker.terminal);
    else unmatched.push(entry);
  }

  if (unmatched.length === 0) return result;

  // Pass 2 — process-tree ancestry.
  const parentMap = await buildParentMap();
  for (const entry of unmatched) {
    const match = terminals.find((t) => t.shellPid > 0 && isDescendantOf(entry.pid, t.shellPid, parentMap));
    if (match) result.set(entry.key, match.terminal);
  }

  return result;
}

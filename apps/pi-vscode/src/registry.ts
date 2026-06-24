import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const BRIDGES_DIR = path.join(AGENT_DIR, "bridges");
const LEGACY_PORT_FILE = path.join(AGENT_DIR, ".pi-bridge-port");

export interface BridgeEntry {
  /** Stable key for this session — the registry filename (pid) or "legacy". */
  key: string;
  port: number;
  pid: number;
  cwd?: string;
  sessionId?: string;
  terminalMarker?: string;
  startedAt?: number;
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseEntry(raw: string, key: string): BridgeEntry | null {
  try {
    const data = JSON.parse(raw);
    if (typeof data.port !== "number" || typeof data.pid !== "number") return null;
    if (!isAlive(data.pid)) return null;
    return {
      key,
      port: data.port,
      pid: data.pid,
      cwd: data.cwd,
      sessionId: data.sessionId,
      terminalMarker: data.terminalMarker,
      startedAt: data.startedAt,
    };
  } catch {
    return null;
  }
}

/** Scan the registry for all live pi-bridge sessions. */
export function scanBridges(): BridgeEntry[] {
  const entries: BridgeEntry[] = [];
  const seenPids = new Set<number>();

  try {
    if (fs.existsSync(BRIDGES_DIR)) {
      for (const file of fs.readdirSync(BRIDGES_DIR)) {
        if (!file.endsWith(".json")) continue;
        const full = path.join(BRIDGES_DIR, file);
        let raw: string;
        try { raw = fs.readFileSync(full, "utf8"); } catch { continue; }
        const entry = parseEntry(raw, file.replace(/\.json$/, ""));
        if (entry) {
          entries.push(entry);
          seenPids.add(entry.pid);
        } else {
          // Stale registry file (process gone / unparseable) — clean it up.
          try { fs.unlinkSync(full); } catch {}
        }
      }
    }
  } catch {}

  // Backward-compat: also honour the old single port file if present.
  try {
    if (fs.existsSync(LEGACY_PORT_FILE)) {
      const raw = fs.readFileSync(LEGACY_PORT_FILE, "utf8");
      const entry = parseEntry(raw, "legacy");
      if (entry && !seenPids.has(entry.pid)) entries.push(entry);
    }
  } catch {}

  return entries;
}

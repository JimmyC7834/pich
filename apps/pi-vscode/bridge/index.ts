import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeServer, type BridgeServerCallbacks } from "./server";
import { registerProxyCommands } from "./commands";
import type { PiToVSCode, VSCodeToPi, SessionInfo, KBCollection, ToolEntry, SkillEntry, KBDocCollection, KBDocEntry, CapabilitiesSnapshot } from "./protocol";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { LoadoutGateway } from "./loadoutGateway.js";
import { safeReadFile } from "./safeRead.js";
import { ralphSnapshot } from "./ralph";

// KB docs live under ~/.pi/kb/collections/<collection>/<doc>.md
const KB_DIR = join(homedir(), ".pi", "kb", "collections");
const SKILLS_DIR = join(homedir(), ".pi", "skills");
const CAP_DIR = join(homedir(), ".pi", "capabilities");
const LOADOUTS_YAML = join(CAP_DIR, "loadouts.yaml");
const READ_ROOTS = [join(homedir(), ".pi", "skills"), join(homedir(), ".pi", "kb"), CAP_DIR];

interface BridgeState {
  model: string;
  thinkingLevel: string;
  isStreaming: boolean;
  activeTools: string[];
  tokensInput: number;
  tokensOutput: number;
  cost: number;
  turns: number;
  toolCalls: number;
  cwd: string;
}

/** Helper: broadcast full state snapshot */
function fullState(s: BridgeState) {
  return { type: "state" as const, data: { ...s } };
}

export default function (pi: ExtensionAPI) {
  let state: BridgeState = {
    model: "",
    thinkingLevel: "off",
    isStreaming: false,
    activeTools: [],
    tokensInput: 0,
    tokensOutput: 0,
    cost: 0,
    turns: 0,
    toolCalls: 0,
    cwd: "",
  };

  let trackedFiles = new Map<string, { status: "M" | "A" | "D"; toolCallId: string }>();
  let pendingFiles: Array<{ path: string; status: "M" | "A" | "D"; toolCallId: string }> = [];
  // Checkpoint baselines: absolute path -> file content at the last "stage".
  // When set, the diff editor compares against this instead of git HEAD.
  let baselines = new Map<string, string>();

const loadouts = new LoadoutGateway(LOADOUTS_YAML);
  registerProxyCommands(pi);

  // ── WS command handler ──
  const commandHandler: BridgeServerCallbacks["onCommand"] = async (msg, reply) => {
    switch (msg.type) {
      case "fork":
        pi.sendUserMessage(`/pi-bridge-fork ${JSON.stringify({ entryId: msg.entryId })}`, { deliverAs: "followUp" });
        break;
      case "resume":
        pi.sendUserMessage(`/pi-bridge-resume ${JSON.stringify({ sessionFile: msg.sessionFile })}`, { deliverAs: "followUp" });
        break;
      case "kb_open": {
        try {
          const kbDir = KB_DIR;
          const collection = (msg as { collection?: string }).collection;
          let content = "";
          if (collection) {
            const docPath = join(kbDir, collection, "docs", `${msg.docId}.md`);
            if (existsSync(docPath)) content = readFileSync(docPath, "utf8");
          } else {
            // Try finding it in any collection
            try {
              for (const col of readdirSync(kbDir)) {
                const p = join(kbDir, col, "docs", `${msg.docId}.md`);
                if (existsSync(p)) { content = readFileSync(p, "utf8"); break; }
              }
            } catch {}
          }
          reply({ type: "response", id: msg.id, data: { content } });
        } catch {
          reply({ type: "response", id: msg.id, data: { content: "" } });
        }
        break;
      }
      case "kb_search": {
        try {
          const kbDir = KB_DIR;
          const query = (msg as { query: string }).query;
          const results: Array<{ id: string; collection: string; snippet: string }> = [];
          if (existsSync(kbDir)) {
            for (const col of readdirSync(kbDir)) {
              const docsPath = join(kbDir, col, "docs");
              if (!existsSync(docsPath) || !statSync(docsPath).isDirectory()) continue;
              for (const f of readdirSync(docsPath)) {
                if (!f.endsWith(".md")) continue;
                const fp = join(docsPath, f);
                const content = readFileSync(fp, "utf8");
                const contentLower = content.toLowerCase();
                const idx = contentLower.indexOf(query.toLowerCase());
                if (idx >= 0) {
                  const start = Math.max(0, idx - 40);
                  const end = Math.min(content.length, idx + query.length + 40);
                  results.push({
                    id: f.replace(/\.md$/, ""),
                    collection: col,
                    snippet: "..." + content.slice(start, end).replace(/\n/g, " ") + "...",
                  });
                }
              }
            }
          }
          reply({ type: "response", id: msg.id, data: { results } });
        } catch {
          reply({ type: "response", id: msg.id, data: { results: [] } });
        }
        break;
      }
      case "diff": {
        try {
          const absPath = resolve(state.cwd || process.cwd(), msg.path);
          // Git needs repo-relative paths, not absolute
          const repoPath = (state.cwd && isAbsolute(msg.path))
            ? relative(state.cwd, absPath).replace(/\\/g, "/")
            : msg.path;
          let original = "";
          const baseline = baselines.get(absPath);
          if (baseline !== undefined) {
            // Diff against the staged checkpoint, not git HEAD.
            original = baseline;
          } else {
            try {
              const r = await pi.exec("git", ["show", `HEAD:${repoPath}`], { timeout: 5000 });
              original = r.stdout;
            } catch { /* file not in HEAD (new file) */ }
          }

          let modified = "";
          try {
            modified = readFileSync(absPath, "utf8");
          } catch { /* file deleted */ }

          let diff = "";
          try {
            const r = await pi.exec("git", ["diff", "--", repoPath], { timeout: 5000 });
            diff = r.stdout;
          } catch { /* not a git repo */ }

          reply({ type: "response", id: msg.id, data: { diff, original, modified } });
        } catch {
          reply({ type: "response", id: msg.id, data: { diff: "", original: "", modified: "" } });
        }
        break;
      }
      case "refresh_capabilities":
        buildAndBroadcastCapabilities();
        break;
      case "checkpoint": {
        // Snapshot current contents of all tracked files as the new diff
        // baseline, then clear the tracked-file record so the panel starts
        // fresh from this point.
        try {
          for (const p of trackedFiles.keys()) {
            const abs = resolve(state.cwd || process.cwd(), p);
            try { baselines.set(abs, readFileSync(abs, "utf8")); } catch { baselines.set(abs, ""); }
          }
          trackedFiles.clear();
          pendingFiles = [];
          server.broadcast({ type: "files_cleared" });
        } catch {}
        break;
      }
      case "command":
        pi.sendUserMessage(msg.command, { deliverAs: "steer" });
        break;
      case "loadout_list":
        reply({ type: "response", id: msg.id, data: loadouts.snapshot() });
        break;
      case "loadout_create":
        loadouts.create(msg.data.name, msg.data);
        reply({ type: "response", id: msg.id, data: loadouts.snapshot() });
        server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
        break;
      case "loadout_update":
        loadouts.update(msg.data.name, msg.data);
        reply({ type: "response", id: msg.id, data: loadouts.snapshot() });
        server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
        break;
      case "loadout_delete":
        loadouts.remove(msg.data.name);
        reply({ type: "response", id: msg.id, data: loadouts.snapshot() });
        server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
        break;
      case "loadout_activate":
        loadouts.setActive(msg.data.name);
        reply({ type: "response", id: msg.id, data: loadouts.snapshot() });
        server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
        break;
      case "tool_toggle": {
        const cur = new Set(pi.getActiveTools());
        if (msg.data.active) cur.add(msg.data.name); else cur.delete(msg.data.name);
        pi.setActiveTools([...cur]);
        reply({ type: "response", id: msg.id, data: { ok: true } });
        buildAndBroadcastCapabilities();
        break;
      }
      case "ralph_refresh":
        try { server.broadcast({ type: "ralph", data: ralphSnapshot() }); } catch { /* fail open */ }
        break;
      case "read_file": {
        const r = safeReadFile(msg.data.path, READ_ROOTS);
        if (r.ok) reply({ type: "response", id: msg.id, data: { path: msg.data.path, content: r.content } });
        else reply({ type: "response", id: msg.id, data: { path: msg.data.path, error: r.error } });
        break;
      }
    }
  };

  // ── Cached state for new-client handshake ──
  let cachedSessions: SessionInfo[] = [];
  let cachedActiveLeaf = "";
  let cachedSkills: Array<{ name: string; description: string; filePath: string }> = [];
  let cachedKBCollections: KBCollection[] = [];
  let cachedCapabilities: CapabilitiesSnapshot | null = null;

  const onConnectHandler: BridgeServerCallbacks["onConnect"] = (send) => {
    send(fullState(state));
    send({ type: "session_tree", data: { sessions: cachedSessions, active: cachedActiveLeaf } });
    send({ type: "skills", data: cachedSkills });
    send({ type: "kb_collections", data: { collections: cachedKBCollections } });
    if (cachedCapabilities) {
      send({ type: "capabilities", data: cachedCapabilities });
    }
    try { send({ type: "ralph", data: ralphSnapshot() }); } catch { /* fail open */ }
  };

  const server = new BridgeServer({ onCommand: commandHandler, onConnect: onConnectHandler });

  // ── Helper: scan KB collections from disk ──
  const scanKB = (): KBCollection[] => {
    const kbDir = KB_DIR;
    try {
      if (!existsSync(kbDir)) return [];
      return readdirSync(kbDir)
        .filter((d) => statSync(join(kbDir, d)).isDirectory())
        .map((name) => {
          try {
            const docsPath = join(kbDir, name, "docs");
            const files = existsSync(docsPath) ? readdirSync(docsPath).filter((f) => f.endsWith(".md")) : [];
            return { name, docCount: files.length };
          } catch {
            return { name, docCount: 0 };
          }
        });
    } catch {
      return [];
    }
  };

  // ── Helper: build & broadcast full capabilities snapshot ──
  const buildAndBroadcastCapabilities = () => {
    const capabilities = { tools: [] as ToolEntry[], skills: [] as SkillEntry[], kBCollections: [] as KBDocCollection[] };

    // Tools
    try {
      const allTools = pi.getAllTools?.() ?? [];
      const activeToolNames = pi.getActiveTools();
      capabilities.tools = allTools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        schema: (t as { parameters?: unknown }).parameters,
        source: (t as { source?: string }).source ?? "builtin",
        sourcePath: (t as { sourceInfo?: { path?: string } }).sourceInfo?.path ?? "",
        isActive: activeToolNames.includes(t.name),
      }));
    } catch {}

    // Skills: the loadout (commands available in this session) is authoritative;
    // the disk catalog adds any installed-but-inactive skills.
    try {
      const loadoutSkills = (pi.getCommands?.() ?? [])
        .filter((c: { source: string }) => c.source === "skill")
        .map((c: { name: string; description?: string; sourceInfo?: { path?: string } }) => ({
          name: c.name,
          description: c.description ?? "",
          filePath: c.sourceInfo?.path ?? "",
        }));
      cachedSkills = loadoutSkills;
      const activeSkillNames = new Set(loadoutSkills.map((s) => s.name));
      const byName = new Map<string, SkillEntry>();

      // Disk catalog (~/.pi/skills/**/SKILL.md)
      if (existsSync(SKILLS_DIR)) {
        const walkDir = (dir: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
            if (entry.isDirectory()) {
              walkDir(join(dir, entry.name));
            } else if (entry.name === "SKILL.md") {
              try {
                const content = readFileSync(join(dir, entry.name), "utf8");
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                let name = basename(dir);
                let description = "";
                let tags: string[] = [];
                if (fmMatch) {
                  for (const line of fmMatch[1].split("\n")) {
                    const colonIdx = line.indexOf(":");
                    if (colonIdx === -1) continue;
                    const key = line.slice(0, colonIdx).trim();
                    const val = line.slice(colonIdx + 1).trim();
                    if (key === "name") name = val;
                    else if (key === "description") description = val;
                    else if (key === "tags") tags = val.split(/[,\s]+/).filter(Boolean);
                  }
                }
                byName.set(name, {
                  name,
                  description,
                  filePath: join(dir, entry.name),
                  tags,
                  category: tags[0] ?? basename(dir),
                  isActive: activeSkillNames.has(name),
                });
              } catch {}
            }
          }
        };
        walkDir(SKILLS_DIR);
      }

      // Ensure every loadout skill appears, even if not found on disk.
      for (const s of loadoutSkills) {
        if (!byName.has(s.name)) {
          byName.set(s.name, { name: s.name, description: s.description, filePath: s.filePath, isActive: true });
        }
      }
      capabilities.skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    } catch {}

    // KB: individual doc details
    try {
      const kbDir = KB_DIR;
      if (existsSync(kbDir)) {
        for (const colDir of readdirSync(kbDir)) {
          const docsPath = join(kbDir, colDir, "docs");
          if (!existsSync(docsPath) || !statSync(docsPath).isDirectory()) continue;
          const docs: KBDocEntry[] = [];
          try {
            for (const f of readdirSync(docsPath)) {
              if (!f.endsWith(".md")) continue;
              const fp = join(docsPath, f);
              try {
                const content = readFileSync(fp, "utf8");
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                let title = f.replace(/\.md$/, "");
                let tags: string[] = [];
                if (fmMatch) {
                  const lines = fmMatch[1].split("\n");
                  for (const line of lines) {
                    const colonIdx = line.indexOf(":");
                    if (colonIdx === -1) continue;
                    const key = line.slice(0, colonIdx).trim();
                    const val = line.slice(colonIdx + 1).trim();
                    if (key === "title") title = val;
                    else if (key === "tags") tags = val.split(/[,\s]+/).filter(Boolean);
                  }
                }
                docs.push({ id: f.replace(/\.md$/, ""), title, filePath: fp, tags });
              } catch {}
            }
          } catch {}
          if (docs.length > 0) {
            capabilities.kBCollections.push({ name: colDir, docs });
          }
        }
      }
    } catch {}

    const snapshot: CapabilitiesSnapshot = {
      activeTools: pi.getActiveTools(),
      activeSkills: cachedSkills.map((s) => s.name),
      ...capabilities,
    };
    cachedCapabilities = snapshot;
    server.broadcast({ type: "capabilities", data: snapshot });
  };

  // ── Event subscriptions ──

  pi.on("session_start", async (_event, ctx) => {
    let sessionId = "";
    try { sessionId = ctx.sessionManager.getLeafId() ?? ""; } catch {}
    await server.start({ cwd: ctx.cwd, sessionId });

    state.cwd = ctx.cwd;
    state.model = ctx.model?.id ?? "";
    state.thinkingLevel = pi.getThinkingLevel();
    state.activeTools = pi.getActiveTools();

    // Session tree
    try {
      const entries = ctx.sessionManager.getEntries();
      cachedSessions = entries.map((e) => ({
        id: e.id,
        parentId: (e as { parentId?: string }).parentId,
        role: e.type === "message" ? (e as { message: { role: string } }).message.role : e.type,
        type: e.type,
      }));
      cachedActiveLeaf = ctx.sessionManager.getLeafId() ?? "";
    } catch {}

    // Skills
    try {
      const commands = pi.getCommands?.() ?? [];
      cachedSkills = commands
        .filter((c: { source: string }) => c.source === "skill")
        .map((c: { name: string; description?: string; sourceInfo: { path: string } }) => ({
          name: c.name,
          description: c.description ?? "",
          filePath: c.sourceInfo.path,
        }));
    } catch {}

    // KB: scan from disk
    cachedKBCollections = scanKB();

    // Broadcast initial state
    server.broadcast(fullState(state));
    server.broadcast({ type: "session_tree", data: { sessions: cachedSessions, active: cachedActiveLeaf } });
    server.broadcast({ type: "skills", data: cachedSkills });
    server.broadcast({ type: "kb_collections", data: { collections: cachedKBCollections } });
    buildAndBroadcastCapabilities();
    server.broadcast({ type: "loadouts", data: loadouts.snapshot() });
  });

  pi.on("agent_start", () => {
    state.isStreaming = true;
    server.broadcast(fullState(state));
  });

  pi.on("agent_end", (event) => {
    state.isStreaming = false;
    for (const msg of event.messages) {
      if (msg.role === "assistant" && "usage" in msg) {
        const usage = msg.usage as { input: number; output: number; cost: { total: number } };
        state.tokensInput += usage.input;
        state.tokensOutput += usage.output;
        state.cost += usage.cost.total;
      }
    }
    for (const f of pendingFiles) {
      trackedFiles.set(f.path, f);
      server.broadcast({ type: "file_changed", data: f });
    }
    pendingFiles = [];
    state.activeTools = pi.getActiveTools();
    server.broadcast(fullState(state));
    // Loadout / active tools may have changed during the turn — refresh.
    buildAndBroadcastCapabilities();
  });

  pi.on("turn_end", () => {
    state.turns++;
    server.broadcast(fullState(state));
    // Keep the kanban live while a Ralph run advances the board.
    try { server.broadcast({ type: "ralph", data: ralphSnapshot() }); } catch { /* fail open */ }
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as { path?: string }).path;
      if (path) {
        server.broadcast({ type: "tool_start", data: { toolName: event.toolName, toolCallId: event.toolCallId, path } });
      }
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as { path?: string }).path;
      if (path) {
        const status = event.toolName === "write" ? "A" : "M";
        state.toolCalls++;
        pendingFiles.push({ path, status, toolCallId: event.toolCallId });
      }
    }
  });

  pi.on("model_select", (event) => {
    state.model = event.model.id;
    server.broadcast(fullState(state));
  });

  pi.on("thinking_level_select", (event) => {
    state.thinkingLevel = event.level;
    server.broadcast(fullState(state));
  });

  pi.on("session_shutdown", async () => {
    server.broadcast({ type: "error", data: { message: "pi shutting down" } });
    await server.stop();
  });
}

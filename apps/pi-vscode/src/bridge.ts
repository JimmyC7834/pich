import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type { PiState, SessionInfo, KBCollection, SkillItem, FileChange, CapabilitiesSnapshot, Loadout, RalphProject } from "./types";

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface PiBridge {
  on<K extends keyof PiBridgeEvents>(event: K, listener: (...args: PiBridgeEvents[K]) => void): this;
  emit<K extends keyof PiBridgeEvents>(event: K, ...args: PiBridgeEvents[K]): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PiBridge extends EventEmitter {
  private ws: WebSocket | null = null;
  private replyId = 0;
  private responseHandlers = new Map<string, { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

  /** Connect to a pi-bridge listening on a specific localhost port. */
  async connect(port: number, maxWaitMs = 5000): Promise<void> {
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const attempt = () => {
        try {
          // Close any existing connection before starting a new one
          if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
          }
          this.ws = new WebSocket(`ws://127.0.0.1:${port}`);

          this.ws.on("open", () => {
            this.emit("connected");
            resolve();
          });

          this.ws.on("message", (raw) => {
            try {
              const msg = JSON.parse(raw.toString());
              this.handleMessage(msg);
            } catch { /* ignore malformed */ }
          });

          this.ws.on("close", (code) => {
            this.emit("disconnected", `WebSocket closed (code ${code})`);
            this.ws = null;
          });

          this.ws.on("error", (err) => {
            this.ws?.removeAllListeners();
            this.ws = null;
            if (Date.now() - start > maxWaitMs) {
              return reject(new Error(`Failed to connect pi-bridge: ${err.message}`));
            }
            setTimeout(attempt, 200);
          });
        } catch (err) {
          if (Date.now() - start > maxWaitMs) {
            return reject(new Error(`Failed to connect pi-bridge: ${(err as Error).message}`));
          }
          setTimeout(attempt, 200);
        }
      };

      attempt();
    });
  }

  async send(cmd: Record<string, unknown>, expectReply = true): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to pi-bridge");
    }

    if (expectReply) {
      const id = `req-${++this.replyId}`;
      cmd.id = id;
      const response = this.waitForReply(id);
      this.ws.send(JSON.stringify(cmd));
      try {
        return await response;
      } finally {
        this.responseHandlers.delete(id);
      }
    }

    this.ws.send(JSON.stringify(cmd));
    return undefined;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    // Clear pending response handlers with timeout
    for (const h of this.responseHandlers.values()) {
      clearTimeout(h.timer);
    }
    this.responseHandlers.clear();
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "state": this.emit("state", msg.data as Partial<PiState>); break;
      case "session_tree": this.emit("sessionTree", msg.data as { sessions: SessionInfo[]; active: string }); break;
      case "kb_collections": this.emit("kbCollections", msg.data as { collections: KBCollection[] }); break;
      case "file_changed": this.emit("fileChanged", msg.data as FileChange); break;
      case "files_cleared": this.emit("filesCleared"); break;
      case "skills": this.emit("skills", msg.data as SkillItem[]); break;
      case "capabilities": this.emit("capabilities", msg.data as CapabilitiesSnapshot); break;
      case "loadouts": this.emit("loadouts", msg.data as { loadouts: Loadout[]; active: string }); break;
      case "ralph": this.emit("ralph", msg.data as { projects: RalphProject[] }); break;
      case "file_content": this.emit("fileContent", msg.data as { path: string; content?: string; error?: string }); break;
      case "error": this.emit("error", (msg.data as { message: string }).message); break;
      case "response": {
        const handler = this.responseHandlers.get(msg.id as string);
        if (handler) {
          clearTimeout(handler.timer);
          handler.resolve(msg.data);
        }
        break;
      }
    }
  }

  // ── Loadout / file request helpers ──
  listLoadouts() { return this.send({ type: "loadout_list" }) as Promise<{ loadouts: Loadout[]; active: string }>; }
  activateLoadout(name: string) { return this.send({ type: "loadout_activate", data: { name } }); }
  createLoadout(data: { name: string; description?: string; skills?: string[]; tools?: string[] }) { return this.send({ type: "loadout_create", data }); }
  updateLoadout(data: { name: string; description?: string; skills?: string[]; tools?: string[] }) { return this.send({ type: "loadout_update", data }); }
  deleteLoadout(name: string) { return this.send({ type: "loadout_delete", data: { name } }); }
  toggleTool(name: string, active: boolean) { return this.send({ type: "tool_toggle", data: { name, active } }); }
  readFile(path: string) { return this.send({ type: "read_file", data: { path } }) as Promise<{ path: string; content?: string; error?: string }>; }

  private waitForReply(id: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseHandlers.delete(id);
        reject(new Error(`Request ${id} timed out`));
      }, 15000);
      this.responseHandlers.set(id, { resolve, timer });
    });
  }
  }


export interface PiBridgeEvents {
  connected: [];
  disconnected: [reason: string];
  state: [data: Partial<PiState>];
  sessionTree: [data: { sessions: SessionInfo[]; active: string }];
  kbCollections: [data: { collections: KBCollection[] }];
  fileChanged: [data: FileChange];
  filesCleared: [];
  skills: [skills: SkillItem[]];
  capabilities: [data: CapabilitiesSnapshot];
  error: [message: string];
  loadouts: [data: { loadouts: Loadout[]; active: string }];
  ralph: [data: { projects: RalphProject[] }];
  fileContent: [data: { path: string; content?: string; error?: string }];
}

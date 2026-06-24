import { WebSocketServer, WebSocket } from "ws";
import type { PiToVSCode, VSCodeToPi } from "./protocol";
import { isVSCodeToPi } from "./protocol";
import { createServer } from "node:net";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Per-session registry: each pi process writes ~/.pi/agent/bridges/<pid>.json so
// multiple concurrent sessions can coexist without stomping a single shared file.
const BRIDGES_DIR = join(homedir(), ".pi", "agent", "bridges");
const MY_PORT_FILE = join(BRIDGES_DIR, `${process.pid}.json`);

export interface BridgeMeta {
  cwd?: string;
  sessionId?: string;
}

export interface BridgeServerCallbacks {
  onCommand: (msg: VSCodeToPi, reply: (response: PiToVSCode) => void) => Promise<void>;
  /** Called when a new client connects — should push full current state */
  onConnect: (send: (event: PiToVSCode) => void) => void;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private port = 0;
  private callbacks: BridgeServerCallbacks;

  constructor(callbacks: BridgeServerCallbacks) {
    this.callbacks = callbacks;
  }

  async start(meta: BridgeMeta = {}): Promise<number> {
    this.port = await findFreePort();

    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.port,
    });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);

      // Push full current state to the newly connected client
      this.callbacks.onConnect((event) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      });

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (!isVSCodeToPi(msg)) return;

          switch (msg.type) {
            case "shutdown":
              await this.stop();
              break;
            default:
              await this.callbacks.onCommand(msg, (response) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(response));
                }
              });
          }
        } catch {}
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });

      ws.on("error", () => {
        this.clients.delete(ws);
      });
    });

    this.wss.on("error", () => {});

    // Write our registry entry so VS Code can discover this session.
    try {
      mkdirSync(BRIDGES_DIR, { recursive: true });
      writeFileSync(
        MY_PORT_FILE,
        JSON.stringify({
          port: this.port,
          pid: process.pid,
          cwd: meta.cwd,
          sessionId: meta.sessionId,
          terminalMarker: process.env.PI_BRIDGE_TERMINAL_ID,
          startedAt: Date.now(),
        }),
      );
    } catch {}

    return this.port;
  }

  /** Push an event to all connected clients */
  broadcast(event: PiToVSCode): void {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      this.wss?.close(() => {
        this.wss = null;
        // Clean up only our own registry entry
        try { unlinkSync(MY_PORT_FILE); } catch {}
        resolve();
      });
    });
  }
}

/** Find a random free port on localhost */
function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "string" ? 0 : addr?.port ?? 0;
      server.close(() => resolve(port));
    });
  });
}

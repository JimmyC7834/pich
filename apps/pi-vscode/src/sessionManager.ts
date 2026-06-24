import * as vscode from "vscode";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PiBridge } from "./bridge";
import { PiStore } from "./store";
import { scanBridges, type BridgeEntry } from "./registry";
import { correlate, type TerminalRef } from "./correlate";

interface Session {
  info: BridgeEntry;
  bridge: PiBridge;
  store: PiStore;
  terminal?: vscode.Terminal;
}

/**
 * Owns a live connection + store for every discovered pi session, and mirrors
 * whichever session is "active" (the focused pi terminal) into a single view
 * store the sidebar providers read from.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface SessionManager {
  on(event: "changed", listener: () => void): this;
  emit(event: "changed"): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SessionManager extends EventEmitter {
  /** The store all sidebar providers bind to — always mirrors the active session. */
  readonly viewStore = new PiStore();

  private sessions = new Map<string, Session>();
  private activeKey: string | null = null;
  private terminalMarkers = new Map<vscode.Terminal, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private correlateTimer: ReturnType<typeof setTimeout> | null = null;
  private disposables: vscode.Disposable[] = [];

  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((t) => this.onActiveTerminalChanged(t)),
      vscode.window.onDidOpenTerminal(() => this.scheduleCorrelate()),
      vscode.window.onDidCloseTerminal((t) => {
        this.terminalMarkers.delete(t);
        this.scheduleCorrelate();
      }),
    );
    this.pollTimer = setInterval(() => void this.refresh(), 2000);
    void this.refresh();
  }

  /** Force an immediate discovery pass (used by manual Connect/Refresh commands). */
  refreshNow(): void {
    void this.refresh();
  }

  /** Register a terminal the extension created, with its injected marker. */
  registerTerminal(terminal: vscode.Terminal, marker: string): void {
    this.terminalMarkers.set(terminal, marker);
    this.scheduleCorrelate();
  }

  // ── Active-session accessors (used by commands + status bar) ──

  /** Convenience accessor — same as getActiveBridge(). */
  get activeBridge(): PiBridge | null { return this.getActiveBridge(); }

  getActiveBridge(): PiBridge | null {
    if (!this.activeKey) return null;
    return this.sessions.get(this.activeKey)?.bridge ?? null;
  }

  isConnected(): boolean {
    return this.getActiveBridge()?.isConnected() ?? false;
  }

  async send(cmd: Record<string, unknown>, expectReply = true): Promise<unknown> {
    const bridge = this.getActiveBridge();
    if (!bridge) throw new Error("No active pi session");
    return bridge.send(cmd, expectReply);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  /** The VS Code terminal of the active session (falls back to the focused terminal). */
  getActiveTerminal(): vscode.Terminal | undefined {
    const own = this.activeKey ? this.sessions.get(this.activeKey)?.terminal : undefined;
    return own ?? vscode.window.activeTerminal;
  }

  /** Send a line to the active session's terminal. Returns false if none available. */
  sendToActive(text: string): boolean {
    const t = this.getActiveTerminal();
    if (!t) return false;
    t.show();
    t.sendText(text, true);
    return true;
  }

  /** 1-based index of the active session among all sessions, or 0 if none. */
  activeIndex(): number {
    if (!this.activeKey) return 0;
    return [...this.sessions.keys()].indexOf(this.activeKey) + 1;
  }

  // ── Discovery ──

  private async refresh(): Promise<void> {
    const entries = scanBridges().filter((e) => this.matchesWorkspace(e.cwd));
    const liveKeys = new Set(entries.map((e) => e.key));

    // Drop sessions whose registry entry is gone.
    for (const [key, s] of this.sessions) {
      if (!liveKeys.has(key)) {
        s.bridge.disconnect();
        this.sessions.delete(key);
        if (this.activeKey === key) this.activeKey = null;
      }
    }

    // Add new sessions / reconnect dropped ones.
    for (const e of entries) {
      const existing = this.sessions.get(e.key);
      if (existing) {
        if (!existing.bridge.isConnected()) {
          existing.bridge.connect(e.port, 4000).catch(() => {});
        }
        continue;
      }
      const session: Session = { info: e, bridge: new PiBridge(), store: new PiStore() };
      this.wire(session);
      this.sessions.set(e.key, session);
      session.bridge
        .connect(e.port, 8000)
        .then(() => session.store.updateState({ cwd: e.cwd }))
        .catch(() => {
          // Couldn't connect — drop so a later refresh can retry cleanly.
          this.sessions.delete(e.key);
          this.emit("changed");
        });
    }

    await this.correlateAndSelect();
    this.emit("changed");
  }

  private wire(session: Session): void {
    const { bridge, store } = session;
    bridge.on("state", (d) => store.updateState(d));
    bridge.on("sessionTree", (d) => store.setSessions(d.sessions, d.active));
    bridge.on("kbCollections", (d) => store.setCollections(d.collections));
    bridge.on("fileChanged", (d) => store.addFileChange(d));
    bridge.on("filesCleared", () => store.clearFiles());
    bridge.on("skills", (s) => store.setSkills(s));
    bridge.on("capabilities", (d) => store.setCapabilities(d));
    // Live updates from the active session flow straight into the view.
    store.on("changed", () => {
      if (this.activeKey === session.info.key) this.mirror();
    });
  }

  // ── Correlation + active selection ──

  private scheduleCorrelate(): void {
    if (this.correlateTimer) clearTimeout(this.correlateTimer);
    this.correlateTimer = setTimeout(() => void this.correlateAndSelect(), 150);
  }

  private async correlateAndSelect(): Promise<void> {
    const entries = [...this.sessions.values()].map((s) => s.info);
    if (entries.length === 0) {
      this.applyActiveSelection(vscode.window.activeTerminal);
      return;
    }

    const termRefs: TerminalRef<vscode.Terminal>[] = [];
    for (const t of vscode.window.terminals) {
      let shellPid = 0;
      try { shellPid = (await t.processId) ?? 0; } catch {}
      termRefs.push({ terminal: t, shellPid, marker: this.terminalMarkers.get(t) });
    }

    const map = await correlate(entries, termRefs);
    for (const s of this.sessions.values()) s.terminal = map.get(s.info.key);

    this.applyActiveSelection(vscode.window.activeTerminal);
  }

  private onActiveTerminalChanged(term: vscode.Terminal | undefined): void {
    // Try the cached correlation first; recorrelate only if the focused
    // terminal isn't mapped to any known session yet.
    const matched = term && [...this.sessions.values()].some((s) => s.terminal === term);
    if (term && !matched && this.sessions.size > 0) {
      void this.correlateAndSelect();
      return;
    }
    this.applyActiveSelection(term);
  }

  private applyActiveSelection(term: vscode.Terminal | undefined): void {
    let key: string | null = null;

    if (term) {
      for (const s of this.sessions.values()) {
        if (s.terminal === term) { key = s.info.key; break; }
      }
    }
    if (!key) {
      // No correlated terminal focused — keep current if valid, else first session.
      if (this.activeKey && this.sessions.has(this.activeKey)) key = this.activeKey;
      else key = this.sessions.size ? [...this.sessions.keys()][0] : null;
    }

    this.setActive(key);
  }

  private setActive(key: string | null): void {
    const changed = key !== this.activeKey;
    this.activeKey = key;
    if (key) this.mirror();
    else this.viewStore.reset();
    if (changed) this.emit("changed");
  }

  private mirror(): void {
    if (!this.activeKey) return;
    const s = this.sessions.get(this.activeKey);
    if (s) this.viewStore.loadSnapshot(s.store.snapshot());
  }

  private matchesWorkspace(cwd?: string): boolean {
    const workspaceCwds = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (workspaceCwds.length === 0) return true;
    if (!cwd) return true;
    const norm = (s: string) => path.normalize(s).replace(/\\/g, "/").toLowerCase();
    const p = norm(cwd);
    return workspaceCwds.some((wc) => {
      const w = norm(wc);
      return w === p || p.startsWith(w + "/") || w.startsWith(p + "/");
    });
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.correlateTimer) clearTimeout(this.correlateTimer);
    for (const d of this.disposables) d.dispose();
    for (const s of this.sessions.values()) s.bridge.disconnect();
    this.sessions.clear();
  }
}

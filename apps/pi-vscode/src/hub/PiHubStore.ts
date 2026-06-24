import { EventEmitter } from "node:events";
import type { PiBridge } from "../bridge";
import type { HubState } from "../types";

export class PiHubStore extends EventEmitter {
  private _state: HubState = {
    connected: false, collections: [], skills: [], tools: [],
    loadouts: [], activeLoadout: null, ralph: [], docContents: {},
  };
  private lastJson = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Named handlers so dispose() can detach them when the view rebinds to a new bridge.
  private readonly onConnected = () => { this._state.connected = true; this.schedule(); this.requestSnapshot(); };
  private readonly onDisconnected = () => { this._state.connected = false; this.schedule(); };
  private readonly onCapabilities = (c: { tools: HubState["tools"]; skills: HubState["skills"]; kBCollections: HubState["collections"] }) => {
    this._state.tools = c.tools; this._state.skills = c.skills;
    this._state.collections = c.kBCollections; this.schedule();
  };
  private readonly onLoadouts = (d: { loadouts: HubState["loadouts"]; active: string }) => {
    this._state.loadouts = d.loadouts; this._state.activeLoadout = d.active; this.schedule();
  };
  private readonly onRalph = (d: { projects: HubState["ralph"] }) => {
    this._state.ralph = d.projects; this.schedule();
  };
  private readonly onFileContent = (d: { path: string; content?: string }) => {
    if (d.content !== undefined) { this._state.docContents[d.path] = d.content; this.schedule(); }
  };

  constructor(private bridge: PiBridge) {
    super();
    this._state.connected = bridge.isConnected();
    bridge.on("connected", this.onConnected);
    bridge.on("disconnected", this.onDisconnected);
    bridge.on("capabilities", this.onCapabilities);
    bridge.on("loadouts", this.onLoadouts);
    bridge.on("ralph", this.onRalph);
    bridge.on("fileContent", this.onFileContent);
    // The hub store is usually created after the bridge connected, so pi-bridge's
    // one-shot capabilities/loadouts broadcasts have already fired and been missed.
    // Proactively pull a fresh snapshot for the current connection.
    this.requestSnapshot();
  }

  get state(): HubState { return this._state; }

  /** Detach all bridge/self listeners. Call before discarding (e.g. rebinding to a new session). */
  dispose(): void {
    this.bridge.off("connected", this.onConnected);
    this.bridge.off("disconnected", this.onDisconnected);
    this.bridge.off("capabilities", this.onCapabilities);
    this.bridge.off("loadouts", this.onLoadouts);
    this.bridge.off("ralph", this.onRalph);
    this.bridge.off("fileContent", this.onFileContent);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.removeAllListeners();
  }

  /**
   * Re-fetch the full snapshot from pi-bridge. `refresh_capabilities` makes
   * pi-bridge re-broadcast its capabilities (handled by the listener above);
   * loadouts aren't part of that broadcast, so pull them directly.
   */
  private requestSnapshot(): void {
    if (!this.bridge.isConnected()) return;
    this.bridge.send({ type: "refresh_capabilities" }, false).catch(() => { /* best effort */ });
    this.bridge.send({ type: "ralph_refresh" }, false).catch(() => { /* best effort */ });
    this.bridge.listLoadouts().then((d) => {
      this._state.loadouts = d.loadouts; this._state.activeLoadout = d.active; this.schedule();
    }).catch(() => { /* best effort */ });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const json = JSON.stringify(this._state);
      if (json === this.lastJson) return;
      this.lastJson = json;
      this.emit("changed", this._state);
    }, 50);
  }
}

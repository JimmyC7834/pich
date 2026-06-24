import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PiBridge } from "../bridge";
import type { SessionManager } from "../sessionManager";
import { PiHubStore } from "./PiHubStore";
import type { HubState } from "../types";

const EMPTY_STATE: HubState = {
  connected: false, collections: [], skills: [], tools: [],
  loadouts: [], activeLoadout: null, ralph: [], docContents: {},
};

/**
 * Hosts the Agent Hub webview as a dockable view (Activity Bar / Panel) instead
 * of an editor tab. Because the view outlives any single pi session, it rebinds
 * its store to whichever session is currently active.
 */
export class PiHubViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private store: PiHubStore | null = null;
  private boundBridge: PiBridge | null = null;
  private distRoot: vscode.Uri;

  /**
   * @param viewId  the contributed view id this provider backs
   * @param distDir folder (under the extension root) holding the built webview
   */
  constructor(
    private context: vscode.ExtensionContext,
    private manager: SessionManager,
    readonly viewId: string,
    distDir: string,
  ) {
    this.distRoot = vscode.Uri.joinPath(context.extensionUri, distDir);
    // Active session can change as terminals are focused / sessions connect.
    manager.on("changed", () => this.syncBinding());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.distRoot] };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((m) => this.onMessage(m));
    webviewView.onDidDispose(() => { this.view = null; });
    this.syncBinding();
    this.post();
  }

  /** Bind the store to the active session's bridge, rebuilding only when it actually changes. */
  private syncBinding(): void {
    const bridge = this.manager.activeBridge;
    if (bridge === this.boundBridge) return;
    this.boundBridge = bridge;
    if (this.store) { this.store.dispose(); this.store = null; }
    if (bridge) {
      this.store = new PiHubStore(bridge);
      this.store.on("changed", () => this.post());
    }
    this.post();
  }

  private post(): void {
    this.view?.webview.postMessage({ type: "state", data: this.store?.state ?? EMPTY_STATE });
  }

  private async onMessage(m: any): Promise<void> {
    const bridge = this.boundBridge;
    switch (m?.type) {
      case "ready": this.post(); break;
      case "readFile": await bridge?.readFile(m.path); break;
      case "toggleTool": await bridge?.toggleTool(m.name, m.active); break;
      case "activateLoadout": await bridge?.activateLoadout(m.name); break;
      case "createLoadout": await bridge?.createLoadout(m.data); break;
      case "updateLoadout": await bridge?.updateLoadout(m.data); break;
      case "deleteLoadout": await bridge?.deleteLoadout(m.name); break;
      case "openInEditor":
        vscode.workspace.openTextDocument(vscode.Uri.file(m.path))
          .then((d) => vscode.window.showTextDocument(d)); break;
      case "revealDir":
        vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(m.path)); break;
      case "persistUi": this.context.workspaceState.update("piHub.ui", m.ui); break;
    }
  }

  private html(webview: vscode.Webview): string {
    const indexPath = join(this.distRoot.fsPath, "index.html");
    let html = readFileSync(indexPath, "utf-8");
    const nonce = Array.from({ length: 24 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
    // Rewrite ./assets refs to webview URIs (Vite emits relative paths with base "./").
    html = html.replace(/(src|href)="\.?\/?(assets\/[^"]+)"/g, (_m, attr, p) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(this.distRoot, p));
      return `${attr}="${uri}"`;
    });
    // Add nonce to every <script> and inject CSP + initial UI state.
    html = html.replace(/<script/g, `<script nonce="${nonce}"`);
    const ui = JSON.stringify(this.context.workspaceState.get("piHub.ui") ?? {});
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<script nonce="${nonce}">window.__PI_HUB_UI__=${ui};</script>`;
    return html.replace("<head>", `<head>${head}`);
  }
}

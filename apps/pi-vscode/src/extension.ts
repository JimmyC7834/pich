import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { PiTerminal } from "./terminal";
import { PiStatusBar } from "./statusBar";
import { registerCommands } from "./commands";
import { PiHubViewProvider } from "./hub/PiHubViewProvider";
import { PiDiffProvider } from "./diff";

export function activate(context: vscode.ExtensionContext) {
  const manager = new SessionManager();
  const store = manager.viewStore;
  const terminal = new PiTerminal();

  // ── Status bar (always visible) ──
  const statusBar = new PiStatusBar(manager);
  statusBar.show();

  // ── Read-only virtual docs for the diff editor (HEAD side / deleted files) ──
  const diffProvider = new PiDiffProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PiDiffProvider.scheme, diffProvider),
  );

  // ── Commands (target the active session) ──
  registerCommands(context, manager, terminal, store, diffProvider);

  // ── pi.start: launch a new pi session in a marked terminal ──
  context.subscriptions.push(
    vscode.commands.registerCommand("pi.start", () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const { terminal: t, marker } = terminal.start(cwd);
      manager.registerTerminal(t, marker);
      vscode.window.showInformationMessage(`Starting pi in: ${cwd}`);
    }),
  );

  // ── pi.connect / pi.refresh: force an immediate discovery pass ──
  context.subscriptions.push(
    vscode.commands.registerCommand("pi.connect", () => {
      manager.refreshNow();
      vscode.window.showInformationMessage("pi: scanning for sessions…");
    }),
    vscode.commands.registerCommand("pi.refresh", () => manager.refreshNow()),
  );

  // ── Hub views (dockable webviews: Activity Bar / Panel) ──
  // Two variants kept side by side for comparison: the hand-styled Svelte hub
  // and a parallel build using @vscode-elements/elements (native VS Code widgets).
  const hubSvelte = new PiHubViewProvider(context, manager, "pi.hubView", "hub-dist");
  const hubVscode = new PiHubViewProvider(context, manager, "pi.hubView.vscode", "hub-dist-vscode");
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(hubSvelte.viewId, hubSvelte, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(hubVscode.viewId, hubVscode, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // "Open Agent Hub" focuses the docked view instead of opening an editor tab.
    vscode.commands.registerCommand("pi.openHub", () =>
      vscode.commands.executeCommand(`${hubSvelte.viewId}.focus`)),
    vscode.commands.registerCommand("pi.openHubVscode", () =>
      vscode.commands.executeCommand(`${hubVscode.viewId}.focus`)),
    vscode.commands.registerCommand("pi.hub.refresh", () => manager.refreshNow()),
  );
  // ── Start discovery (picks up sessions already running on startup) ──
  manager.start();

  // ── Cleanup ──
  context.subscriptions.push({
    dispose: () => {
      manager.dispose();
      statusBar.dispose();
    },
  });
}

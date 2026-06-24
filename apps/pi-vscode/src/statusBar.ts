import * as vscode from "vscode";
import type { SessionManager } from "./sessionManager";
import type { PiStore } from "./store";

/** Status bar shown in the bottom bar. Shows pi connection state and live stats. */

export class PiStatusBar {
  private item: vscode.StatusBarItem;
  private store: PiStore;

  constructor(private manager: SessionManager) {
    this.store = manager.viewStore;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "pi.showActions";
    this.store.on("changed", () => this.update());
    manager.on("changed", () => this.update());
    this.update();
  }

  show(): void {
    this.item.show();
    this.update();
  }

  hide(): void {
    this.item.hide();
  }

  private update(): void {
    const s = this.store.state;
    const count = this.manager.sessionCount();

    if (count === 0) {
      this.item.text = "$(sync~spin) pi: searching...";
      this.item.tooltip = "Looking for a running pi session...";
      return;
    }

    if (s.isStreaming) {
      this.item.text = "$(loading~spin) pi";
    } else {
      this.item.text = "$(hubot) pi";
    }

    const parts: string[] = [];
    if (s.model) parts.push(s.model);
    if (s.tokensInput != null && s.tokensOutput != null) {
      const inp = s.tokensInput < 1000 ? `${s.tokensInput}` : `${(s.tokensInput / 1000).toFixed(1)}k`;
      const out = s.tokensOutput < 1000 ? `${s.tokensOutput}` : `${(s.tokensOutput / 1000).toFixed(1)}k`;
      parts.push(`↑${inp} ↓${out}`);
    }
    if (s.cost != null && s.cost > 0) parts.push(`$${s.cost.toFixed(2)}`);
    // Show which session is active when more than one is running.
    if (count > 1) parts.push(`sess ${this.manager.activeIndex()}/${count}`);

    if (parts.length > 0) {
      this.item.text += `: ${parts.join(" | ")}`;
    }

    this.item.tooltip = `Sessions: ${count}\nModel: ${s.model || "loading..."}\nThinking: ${s.thinkingLevel}\nTurns: ${s.turns}\nTool calls: ${s.toolCalls}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}

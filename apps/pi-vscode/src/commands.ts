import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import type { SessionManager } from "./sessionManager";
import type { PiTerminal } from "./terminal";
import type { PiStore } from "./store";
import type { PiDiffProvider } from "./diff";

export function registerCommands(
  context: vscode.ExtensionContext,
  manager: SessionManager,
  terminal: PiTerminal,
  store: PiStore,
  diffProvider: PiDiffProvider,
): void {
  const cmd = (command: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));

  cmd("pi.stop", async () => {
    await manager.send({ type: "shutdown" as const }, false).catch(() => {});
    manager.getActiveTerminal()?.sendText("\x03");
  });
  cmd("pi.newSession", () => manager.sendToActive("/new"));
  cmd("pi.forkSession", (entry: unknown) => {
    const e = entry as { id?: string } | undefined;
    if (e?.id) manager.send({ type: "fork" as const, entryId: e.id }, false).catch(() => {});
  });
  cmd("pi.resumeSession", (entry: unknown) => {
    const e = entry as { sessionFile?: string } | undefined;
    if (e?.sessionFile) manager.send({ type: "resume" as const, sessionFile: e.sessionFile }, false).catch(() => {});
  });

  cmd("pi.showDiff", async (file: unknown) => {
    const f = file as { path?: string; status?: string } | undefined;
    if (!f?.path) return;

    // Resolve relative paths against the pi cwd (workspace root)
    let filePath = f.path;
    if (!path.isAbsolute(filePath)) {
      const cwd = store.state.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      filePath = path.resolve(cwd, filePath);
    }

    try {
      const result = (await manager.send({ type: "diff" as const, path: filePath })) as {
        diff?: string;
        original?: string;
        modified?: string;
      };

      const original = result?.original ?? "";
      const modified = result?.modified ?? "";
      const fileName = path.basename(filePath);

      if (original === "" && modified === "") {
        // Neither available — try to open file directly
        try { await vscode.window.showTextDocument(vscode.Uri.file(filePath)); } catch {}
        return;
      }

      // Left side (HEAD): read-only virtual document — never prompts to save.
      const leftUri = diffProvider.set(fileName, original, "HEAD");

      // Right side (working tree): the real file on disk when it still exists
      // (saves normally); otherwise a read-only virtual doc (e.g. deleted file).
      const rightUri = fs.existsSync(filePath)
        ? vscode.Uri.file(filePath)
        : diffProvider.set(fileName, modified, "working");

      await vscode.commands.executeCommand(
        "vscode.diff",
        leftUri,
        rightUri,
        `${fileName}: HEAD → Working Tree`,
      );
    } catch {
      // Fallback: just open the file
      try { await vscode.window.showTextDocument(vscode.Uri.file(filePath)); } catch {}
    }
  });

  cmd("pi.openKBDoc", async (doc: unknown) => {
    const d = doc as { docId?: string; collection?: string } | undefined;
    if (!d?.docId) return;
    const result = (await manager.send({
      type: "kb_open" as const,
      docId: d.docId,
      collection: d.collection,
    })) as { content?: string };
    if (result?.content) {
      const td = await vscode.workspace.openTextDocument({ content: result.content, language: "markdown" });
      await vscode.window.showTextDocument(td);
    }
  });

  cmd("pi.inspectSkill", async (skill: unknown) => {
    const s = skill as { filePath?: string } | undefined;
    if (!s?.filePath) return;
    const uri = vscode.Uri.file(s.filePath);
    await vscode.window.showTextDocument(uri);
  });

  cmd("pi.inspectTool", async (tool: unknown) => {
    const t = tool as { name?: string; schema?: unknown } | undefined;
    if (!t?.name) return;
    const json = JSON.stringify(
      { name: t.name, ...(t.schema ? { schema: t.schema } : {}) },
      null,
      2,
    );
    const doc = await vscode.workspace.openTextDocument({ content: json, language: "json" });
    await vscode.window.showTextDocument(doc);
  });

  cmd("pi.runSkill", (skill: unknown) => {
    const s = skill as { name?: string } | undefined;
    if (!s?.name) return;
    manager.sendToActive(`/skill:${s.name}`);
  });

  cmd("pi.refreshCapabilities", () => {
    manager.send({ type: "refresh_capabilities" as const }, false).catch(() => {});
  });

  cmd("pi.stageFiles", async () => {
    try {
      await manager.send({ type: "checkpoint" as const }, false);
      vscode.window.setStatusBarMessage("pi: staged — diffs now baseline from here", 3000);
    } catch {
      vscode.window.showWarningMessage("pi: no active session to stage");
    }
  });

  // Status bar click → action picker
  cmd("pi.showActions", async () => {
    const connected = manager.isConnected();
    const choice = await vscode.window.showQuickPick(
      connected
        ? [
            { label: "$(debug-stop) Stop pi", action: "stop" },
            { label: "$(add) New Session", action: "new" },
          ]
        : [
            { label: "$(debug-start) Start pi", action: "start" },
            { label: "$(plug) Connect", action: "connect" },
          ],
      { placeHolder: "pi actions" },
    );
    if (!choice) return;
    if (choice.action === "start") vscode.commands.executeCommand("pi.start");
    if (choice.action === "connect") vscode.commands.executeCommand("pi.connect");
    if (choice.action === "stop") vscode.commands.executeCommand("pi.stop");
    if (choice.action === "new") vscode.commands.executeCommand("pi.newSession");
  });
}

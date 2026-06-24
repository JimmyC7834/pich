import * as vscode from "vscode";
import { randomUUID } from "node:crypto";

const TERMINAL_NAME = "pi";

/** Launches pi in a VS Code terminal, tagging it with a unique marker env var
 *  so the SessionManager can correlate the resulting pi process to this terminal. */
export class PiTerminal {
  /** Create a new terminal, run pi, and return the terminal + its correlation marker. */
  start(cwd: string): { terminal: vscode.Terminal; marker: string } {
    const marker = randomUUID();

    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd,
      hideFromUser: false,
      env: { PI_BRIDGE_TERMINAL_ID: marker },
    });

    terminal.show();
    const sessionDir = `${cwd}/.pi/sessions`;
    terminal.sendText(`pi --session-dir "${sessionDir}"`, true);

    return { terminal, marker };
  }
}

import * as vscode from "vscode";

/**
 * Serves read-only virtual documents for the diff editor (e.g. the git HEAD
 * side of a file). Documents from a TextDocumentContentProvider are read-only,
 * so the diff editor never prompts to save them.
 */
export class PiDiffProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "pi-diff";

  private contents = new Map<string, string>();
  private counter = 0;
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** Register a virtual document and return a URI that resolves to `content`. */
  set(fileName: string, content: string, label: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: PiDiffProvider.scheme,
      // Keep the real filename (with extension) so VS Code infers the language.
      path: `/${label}/${fileName}`,
      query: `${this.counter++}`,
    });
    this.contents.set(uri.toString(), content);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

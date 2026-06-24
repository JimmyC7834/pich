import type { HubState } from "./types";
const vscode = (window as any).acquireVsCodeApi?.() ?? { postMessage() {}, getState() {}, setState() {} };
export const initialUi = (window as any).__PI_HUB_UI__ ?? {};
export function post(msg: unknown) { vscode.postMessage(msg); }
export function onState(cb: (s: HubState) => void) {
  window.addEventListener("message", (e) => { if (e.data?.type === "state") cb(e.data.data); });
}
export function ready() { post({ type: "ready" }); }
export function persistUi(ui: unknown) { vscode.setState(ui); post({ type: "persistUi", ui }); }

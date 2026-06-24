/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when:
 * - Agent asks you a question (tool_call on ask_user_question)
 * - Agent finishes a turn and is ready for input (agent_end),
 *   unless the turn ended because you cancelled a question
 *
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("child_process");
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

export default function (pi: ExtensionAPI) {
	let lastAskCancelled = false;
	let turnSignal: AbortSignal | undefined;

	pi.on("agent_start", async (_event, ctx) => {
		turnSignal = ctx.signal;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "ask_user_question") return;
		// ask_user_question returns its structured result in `details`.
		const details = (event as { details?: unknown }).details as { cancelled?: boolean } | undefined;
		lastAskCancelled = !!details?.cancelled;
	});

	pi.on("agent_end", async () => {
		if (turnSignal?.aborted) {
			turnSignal = undefined;
			return;
		}
		if (lastAskCancelled) {
			lastAskCancelled = false;
			turnSignal = undefined;
			return;
		}
		notify("Pi", "Ready for input");
		turnSignal = undefined;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "ask_user_question") {
			notify("Pi", "Agent needs your input");
		}
	});
}

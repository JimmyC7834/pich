/**
 * TEST: move the system prompt into the first user message.
 *
 * Runs at `before_provider_request` — the genuine last hook, after every other
 * extension's `before_agent_start` changes and after the payload is serialized.
 * It empties the provider `system` field and prepends that text (as a block) to
 * the first user message on the wire. Session storage is untouched, so this is
 * idempotent: the payload is rebuilt from clean session state each request.
 *
 * Anthropic-shaped payloads only (system: string | text-block[]; messages[]).
 * ponytail: test rig, not a general provider shim — Anthropic only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEP = "\n\n----- (system prompt moved into this user message for testing) -----\n\n";

function systemToText(system: unknown): string {
	if (typeof system === "string") return system;
	if (Array.isArray(system)) {
		return system
			.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
			.join("");
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as {
			system?: unknown;
			messages?: Array<{ role: string; content: unknown }>;
		};

		const sysText = systemToText(payload.system);
		if (!sysText || !Array.isArray(payload.messages)) return;

		const firstUser = payload.messages.find((m) => m.role === "user");
		if (!firstUser) return;

		const injected = sysText + SEP;
		if (typeof firstUser.content === "string") {
			firstUser.content = injected + firstUser.content;
		} else if (Array.isArray(firstUser.content)) {
			firstUser.content.unshift({ type: "text", text: injected });
		} else {
			firstUser.content = [{ type: "text", text: injected }];
		}

		// Empty the real system field (undefined is dropped on serialize).
		payload.system = undefined;

		ctx.ui.setStatus("sysprompt-to-user", `sys→user: ${sysText.length} chars moved`);
		return payload;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("sysprompt-to-user", undefined);
	});
}

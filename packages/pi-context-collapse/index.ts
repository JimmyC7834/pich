import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OriginalsCache } from "./src/cache";
import { Metrics } from "./src/metrics";
import { registerExpandTool } from "./src/expand";
import { pruneMessages } from "./src/prune";

export default function (pi: ExtensionAPI): void {
	// Co-locate runtime artifacts with pi's own per-project state under
	// <cwd>/.pi/ (alongside .pi/sessions, .pi/code-vocab). Override with
	// PI_COLLAPSE_DIR to pin a fixed location.
	const dir = process.env.PI_COLLAPSE_DIR ?? join(process.cwd(), ".pi", "collapse");
	let cache: OriginalsCache;
	try {
		mkdirSync(dir, { recursive: true });
		cache = new OriginalsCache(join(dir, ".pi-collapse.db"));
	} catch {
		// Cannot create the dir or open the originals cache (e.g. read-only path).
		// Degrade to a no-op — leave tool results untouched — rather than throwing
		// out of the extension entrypoint and disrupting the host session.
		return;
	}
	const metrics = new Metrics(join(dir, ".pi-collapse-metrics.jsonl"));

	registerExpandTool(pi, cache, metrics);

	// Lazy, cache-aware trimming: instead of collapsing each tool result the
	// instant it arrives (newest = cache-hot, still in use), we trim OLD results
	// just before each LLM call, leaving the recent tail intact. Session storage
	// keeps full-fidelity results; only the in-context view is trimmed. The memo
	// keeps re-trimming the same history cheap and records each collapse metric
	// once. ponytail: recompresses old history per call; memo caps that to one
	// pass per unique result. Persist the pruned form if that ceiling bites.
	const memo = new Map<string, string>();
	pi.on("context", (event) => {
		const messages = (event as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) return;
		const { messages: pruned } = pruneMessages(messages, cache, {
			memo,
			onTrim: (info) =>
				metrics.record({
					kind: "collapse",
					type: info.type,
					toolName: info.toolName,
					rawTokens: info.rawTokens,
					collapsedTokens: info.collapsedTokens,
				}),
		});
		return { messages: pruned } as unknown as void;
	});

	// Release the SQLite handle when the session ends so the db file isn't held
	// open after pi exits.
	pi.on("session_shutdown", () => cache.close());
}

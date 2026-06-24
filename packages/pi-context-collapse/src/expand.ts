import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseHandle } from "./handle";
import { estimateTokens } from "./tokens";
import type { OriginalsCache } from "./cache";
import type { Metrics } from "./metrics";

const MAX_EXPAND_CHARS = 16000;

/** Register the `expand` tool: returns the raw original (sliced) for a collapse handle. */
export function registerExpandTool(
	pi: ExtensionAPI,
	cache: OriginalsCache,
	metrics: Metrics,
): void {
	pi.registerTool({
		name: "expand",
		label: "Expand",
		description:
			"Return the raw original of a collapsed tool result. Pass the ⟦type:hash⟧ handle (or just its hash) shown in a collapsed result. Use offset to page through large originals.",
		parameters: Type.Object({
			handle: Type.String({ description: "the ⟦type:hash⟧ marker or the bare hash" }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "character offset to start from (default 0)" }),
			),
		}),
		async execute(_toolCallId: string, params: { handle: string; offset?: number }) {
			const parsed = parseHandle(params.handle) ?? { hash: params.handle.trim() };
			const rec = cache.get(parsed.hash);
			if (!rec) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[E_NO_ORIGINAL] No cached original for handle "${params.handle}". It may have expired or never been collapsed.`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			const offset = params.offset ?? 0;
			const slice = rec.raw.slice(offset, offset + MAX_EXPAND_CHARS);
			const end = offset + slice.length;
			metrics.record({
				kind: "expand",
				hash: parsed.hash,
				type: rec.type,
				toolName: rec.toolName,
				returnedTokens: estimateTokens(slice),
			});
			const more =
				end < rec.raw.length
					? `\n\n[Showing chars ${offset}-${end} of ${rec.raw.length}. Use offset=${end} to continue.]`
					: "";
			return { content: [{ type: "text" as const, text: slice + more }], details: undefined };
		},
	});
}

import { classify, type ContentType } from "./router";
import { compressJson } from "./compressors/json";
import { compressLog } from "./compressors/log";
import { compressPaths } from "./compressors/paths";
import { compressUseless } from "./compressors/useless";
import { hashContent, makeHandle } from "./handle";
import type { OriginalsCache } from "./cache";

const COMPRESSORS: Record<ContentType, (text: string) => string> = {
	json: compressJson,
	log: compressLog,
	paths: compressPaths,
	useless: compressUseless,
};

export interface CollapseResult {
	collapsed: string;
	handle: string;
	type: ContentType;
}

/**
 * Deterministic single-pass collapse. Returns null to pass the result through
 * unchanged. On collapse, the raw original is saved to `cache` before returning.
 */
export function collapseText(params: {
	toolName: string;
	text: string;
	cache: OriginalsCache;
	now?: () => number;
}): CollapseResult | null {
	const { toolName, text, cache } = params;
	const type = classify(toolName, text);
	if (!type) return null;

	const compressed = COMPRESSORS[type](text);
	if (compressed.length >= text.length) return null;

	const hash = hashContent(text);
	const handle = makeHandle(type, hash);
	cache.save(hash, { raw: text, toolName, type, createdAt: (params.now ?? Date.now)() });

	const collapsed = `${handle} ${type} collapsed — use the expand tool with this handle for the raw original.\n${compressed}`;
	return { collapsed, handle, type };
}

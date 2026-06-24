/** Cheap deterministic token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

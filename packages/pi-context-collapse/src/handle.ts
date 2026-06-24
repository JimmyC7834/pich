import { createHash } from "node:crypto";

/** Content-addressed 12-hex-char key for an original tool result. */
export function hashContent(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Build the in-context marker, e.g. "⟦json:abc123⟧". */
export function makeHandle(type: string, hash: string): string {
	return `⟦${type}:${hash}⟧`;
}

const HANDLE_RE = /⟦([a-z]+):([0-9a-f]{6,64})⟧/;

/** Extract { type, hash } from text containing a handle, else null. */
export function parseHandle(text: string): { type: string; hash: string } | null {
	const m = text.match(HANDLE_RE);
	return m ? { type: m[1]!, hash: m[2]! } : null;
}

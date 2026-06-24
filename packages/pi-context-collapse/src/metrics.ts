import { appendFileSync } from "node:fs";

export interface MetricEvent {
	kind: "collapse" | "expand";
	type?: string;
	toolName?: string;
	rawTokens?: number;
	collapsedTokens?: number;
	/** Tokens returned by an expand call — the cost that offsets collapse savings. */
	returnedTokens?: number;
	hash?: string;
}

/** Append-only JSONL metrics sink. Best-effort: never throws into the tool path. */
export class Metrics {
	constructor(private readonly path: string) {}

	record(event: MetricEvent): void {
		try {
			appendFileSync(this.path, `${JSON.stringify({ ...event, ts: Date.now() })}\n`);
		} catch {
			// metrics are best-effort; swallow IO errors so collapse never fails on logging
		}
	}
}

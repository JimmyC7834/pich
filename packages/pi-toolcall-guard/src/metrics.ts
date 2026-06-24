import { appendFileSync } from "node:fs";
import type { Severity } from "./destructive";

export type GuardEvent =
	| { kind: "preflight"; outcome: "normalized" | "block"; toolName: string }
	| { kind: "preflight_recovered"; toolName: string }
	| { kind: "enrich"; matched: boolean; rule?: string; toolName: string }
	| { kind: "nudge"; toolName: string; rule: string; tool: string }
	| { kind: "rule"; toolName: string; action: "block" | "remind"; rules: string }
	| { kind: "stream"; toolName: string; source: "text" | "thinking"; rule: string }
	| { kind: "repair"; toolName: string; pattern: string; field: string }
	| { kind: "repair_recovered"; toolName: string }
	| { kind: "schema_block"; toolName: string; violations: string }
	| { kind: "bash_guard"; toolName: "bash"; outcome: "headless_block" | "prompt_block" | "prompt_allow" | "repeat_block"; severity: Severity; reasons: string };

/** Append-only JSONL metrics sink. Best-effort: never throws into the tool path. */
export class Metrics {
	constructor(private readonly path: string) {}

	record(event: GuardEvent): void {
		try {
			appendFileSync(this.path, `${JSON.stringify({ ...event, ts: Date.now() })}\n`);
		} catch {
			// metrics are best-effort; swallow IO errors so the guard never fails on logging
		}
	}
}

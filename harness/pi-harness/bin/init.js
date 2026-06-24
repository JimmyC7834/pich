#!/usr/bin/env node
// @jc4649/pi-harness init — wire the harness into ~/.pi non-destructively.
//
//   npx @jc4649/pi-harness init
//
// Adds every harness package to ~/.pi/agent/settings.json `packages` (as
// npm: sources) without removing anything you already configured, and turns
// off pi's built-in compaction so @jc4649/pi-autocompact can own it (only if
// you haven't set a compaction policy yourself).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The harness package set, in load order. The umbrella ships last (its glue
 *  composes after the feature extensions). Kept here so the bin is the single
 *  source of truth for "what the 1-click installs". */
export const HARNESS_PACKAGES = [
	"@jc4649/pi-toolcall-guard",
	"@jc4649/pi-context-collapse",
	"@jc4649/pi-capability-index",
	"@jc4649/pi-ralph",
	"@jc4649/pi-semble",
	"@jc4649/pi-usage-recorder",
	"@jc4649/filechanges",
	"@jc4649/telegram-remote",
	"@jc4649/notify",
	"@jc4649/pi-autocompact",
	"@jc4649/pi-web-tools",
	"@jc4649/pi-hashline-edit",
	"@jc4649/pi-harness",
];

/** True if a PackageSource (string or {source}) already references `name`. */
function sourceName(src) {
	const s = typeof src === "string" ? src : src?.source;
	if (typeof s !== "string") return undefined;
	return s.startsWith("npm:") ? s.slice(4) : s;
}

/**
 * Merge harness packages into existing settings without clobbering user config.
 * Pure: returns a NEW settings object, never mutates the input.
 */
export function mergeSettings(existing, packageNames) {
	const settings = structuredClone(existing ?? {});
	const have = new Set((settings.packages ?? []).map(sourceName).filter(Boolean));
	const additions = packageNames.filter((n) => !have.has(n)).map((n) => `npm:${n}`);
	settings.packages = [...(settings.packages ?? []), ...additions];

	// Only suggest disabling built-in compaction if the user hasn't decided.
	if (settings.compaction === undefined) {
		settings.compaction = { enabled: false };
	}
	return { settings, added: additions.map((s) => s.slice(4)) };
}

function main() {
	const agentDir = join(homedir(), ".pi", "agent");
	const settingsPath = join(agentDir, "settings.json");

	let existing = {};
	if (existsSync(settingsPath)) {
		try {
			existing = JSON.parse(readFileSync(settingsPath, "utf8"));
		} catch (e) {
			console.error(`Could not parse ${settingsPath}: ${e.message}`);
			console.error("Fix or remove it, then re-run. Not touching it.");
			process.exit(1);
		}
	}

	const { settings, added } = mergeSettings(existing, HARNESS_PACKAGES);
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

	console.log(`pi-harness: wrote ${settingsPath}`);
	console.log(added.length ? `  added ${added.length} package(s): ${added.join(", ")}` : "  already configured — nothing to add");
	console.log("");
	console.log("Next:");
	console.log("  1. Launch pi — it installs the npm packages on first run.");
	console.log("  2. telegram-remote is inert until you create ~/.pi/telegram-remote.json (see its README).");
	console.log("  3. VS Code companion is separate: install the .vsix from apps/pi-vscode.");
}

// Run only when invoked as a script, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}

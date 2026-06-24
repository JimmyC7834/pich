const MAX_DIRS = 8;

/** Deterministic path-list summary: total count + top directories by frequency. */
export function compressPaths(text: string): string {
	const paths = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const dirs = new Map<string, number>();
	for (const p of paths) {
		const parts = p.split(/[/\\]/);
		const top = parts.length >= 2 ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
		dirs.set(top, (dirs.get(top) ?? 0) + 1);
	}
	const top = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DIRS);
	const out = [`${paths.length} paths in ${dirs.size} dirs:`];
	for (const [d, n] of top) out.push(`  ${d} (${n})`);
	return out.join("\n");
}

// Deterministic log minimizer. Layered after oh-my-pi's shell minimizer:
// strip ANSI -> drop well-known noise lines -> dedupe -> head/tail cap.
// Lossy by design; the raw original is always recoverable via the expand tool.

// ANSI CSI + OSC escape sequences.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching real terminal escapes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Common build/shell chatter. ponytail: conservative — only lines that are
// reliably non-informational. Never match error/warning-of-substance shapes.
const NOISE_RE: RegExp[] = [
	/^[\s=#>.\-|/\\*]*\d{1,3}%[\s=#>.\-|/\\*]*$/, // progress bars carrying a percentage
	/^\s*\[\d+\/\d+\]/, // [3/12] step counters
	/^\s*(Downloading|Downloaded|Fetching|Unpacking|Extracting|Resolving|Collecting|Preparing)\b/i,
	/^\s*Requirement already satisfied\b/i,
	/^\s*(Compiling|Updating)\b.*\b(crates\.io|index|v?\d+\.\d+)/i, // cargo progress
	/^\s*npm (warn|notice|http|verb|sill|timing)\b/i,
	/^\s*(added|removed|changed|audited) \d+ packages?\b/i,
	/^\s*(yarn|pnpm) (info|warning)\b/i,
];

const HEAD_LINES = 40;
const TAIL_LINES = 40;

export function compressLog(text: string): string {
	let lines = text.replace(ANSI_RE, "").split("\n");
	lines = lines.filter((l) => !NOISE_RE.some((re) => re.test(l)));

	// Dedupe: each unique line once (first-seen order) with a (×N) count.
	const order: string[] = [];
	const counts = new Map<string, number>();
	for (const line of lines) {
		if (!counts.has(line)) order.push(line);
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	let out = order.map((line) => {
		const n = counts.get(line)!;
		return n > 1 ? `${line}  (×${n})` : line;
	});

	// Head+tail cap: errors live at the tail, the command at the head.
	if (out.length > HEAD_LINES + TAIL_LINES + 1) {
		const omitted = out.length - HEAD_LINES - TAIL_LINES;
		out = [
			...out.slice(0, HEAD_LINES),
			`… [${omitted} lines elided — expand for full output] …`,
			...out.slice(-TAIL_LINES),
		];
	}
	return out.join("\n");
}

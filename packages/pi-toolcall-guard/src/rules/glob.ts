/**
 * Minimal glob matcher.
 *
 * Supports `*`, `**`, `?`, and brace expansion `{a,b,c}` — enough for the
 * scope/path patterns used by TTSR rules (e.g. `*.ts`, `**\/*.{ts,tsx}`,
 * `*.test.ts`). No external dependency. Matches against the full normalized
 * path and, as a fallback, the basename (mirrors oh-my-pi behavior).
 */

/** Expand `{a,b}` alternations into concrete patterns (recursive). */
export function expandBraces(pattern: string): string[] {
	const match = /\{([^{}]*)\}/.exec(pattern);
	if (!match) {
		return [pattern];
	}
	const [full, body] = match;
	const start = match.index;
	const pre = pattern.slice(0, start);
	const post = pattern.slice(start + full.length);
	const out: string[] = [];
	for (const option of body.split(",")) {
		for (const expanded of expandBraces(pre + option + post)) {
			out.push(expanded);
		}
	}
	return out;
}

function segmentToRegexSource(glob: string): string {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				// `**` matches any characters including path separators.
				re += ".*";
				i++;
				if (glob[i + 1] === "/") {
					i++;
				}
			} else {
				re += "[^/]*";
			}
		} else if (char === "?") {
			re += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(char)) {
			re += `\\${char}`;
		} else {
			re += char;
		}
	}
	return re;
}

/** Compile a single glob (no brace expansion) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
	return new RegExp(`^${segmentToRegexSource(glob)}$`);
}

function normalizePath(p: string): string {
	return p.replaceAll("\\", "/");
}

/** True when any of `paths` matches `glob` (full path or basename). */
export function matchGlob(glob: string, paths: readonly string[] | undefined): boolean {
	if (!paths || paths.length === 0) {
		return false;
	}
	const regexes = expandBraces(glob).map(globToRegExp);
	for (const raw of paths) {
		const normalized = normalizePath(raw);
		const slash = normalized.lastIndexOf("/");
		const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
		for (const regex of regexes) {
			if (regex.test(normalized)) {
				return true;
			}
			if (basename !== normalized && regex.test(basename)) {
				return true;
			}
		}
	}
	return false;
}

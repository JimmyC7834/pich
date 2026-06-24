/**
 * Tiny frontmatter parser for rule `.md` files.
 *
 * Handles the small YAML subset the rule files actually use:
 *   - `key: value`
 *   - `key: "value"` / `key: 'value'`
 *   - block lists:
 *       key:
 *         - item
 *         - "item"
 *
 * Double-quoted scalars only unescape `\\` and `\"` so that regex backslashes
 * (e.g. `\.lock\(\)`) survive intact. No external YAML dependency.
 */

export interface ParsedRuleFile {
	frontmatter: Record<string, string | string[]>;
	body: string;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed.at(-1) === '"') {
		const inner = trimmed.slice(1, -1);
		let out = "";
		for (let i = 0; i < inner.length; i++) {
			if (inner[i] === "\\" && (inner[i + 1] === "\\" || inner[i + 1] === '"')) {
				out += inner[i + 1];
				i++;
			} else {
				out += inner[i];
			}
		}
		return out;
	}
	if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed.at(-1) === "'") {
		return trimmed.slice(1, -1).replaceAll("''", "'");
	}
	return trimmed;
}

export function parseRuleFile(text: string): ParsedRuleFile {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { frontmatter: {}, body: normalized.trim() };
	}
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) {
		return { frontmatter: {}, body: normalized.trim() };
	}
	const fmBlock = normalized.slice(4, end);
	const afterMarker = normalized.indexOf("\n", end + 1);
	const body = afterMarker === -1 ? "" : normalized.slice(afterMarker + 1).trim();

	const frontmatter: Record<string, string | string[]> = {};
	const lines = fmBlock.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim().length === 0) {
			i++;
			continue;
		}
		const keyMatch = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
		if (!keyMatch) {
			i++;
			continue;
		}
		const key = keyMatch[1];
		const rest = keyMatch[2].trim();
		if (rest.length > 0) {
			frontmatter[key] = unquote(rest);
			i++;
			continue;
		}
		// Possible block list on following indented `- ` lines.
		const items: string[] = [];
		let j = i + 1;
		while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
			items.push(unquote(lines[j].replace(/^\s*-\s+/, "")));
			j++;
		}
		if (items.length > 0) {
			frontmatter[key] = items;
			i = j;
		} else {
			frontmatter[key] = "";
			i++;
		}
	}
	return { frontmatter, body };
}

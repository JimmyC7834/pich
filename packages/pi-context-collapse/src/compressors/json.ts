function shape(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return `array[${v.length}]`;
	if (typeof v === "object") return `object{${Object.keys(v as object).join(",")}}`;
	return typeof v;
}

/** Helper to describe array: "array[N]" for empty, "array[N] of <shape>" for non-empty. */
function arrayDesc(arr: unknown[]): string {
	if (arr.length === 0) return `array[0]`;
	return `array[${arr.length}] of ${shape(arr[0])}`;
}

/** Deterministic structural summary of bulky JSON: shape + counts + one sample row. */
export function compressJson(text: string): string {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return text;
	}
	const lines: string[] = [];
	if (Array.isArray(data)) {
		lines.push(arrayDesc(data));
		if (data.length > 0) lines.push(`sample[0]=${JSON.stringify(data[0])}`);
	} else if (data && typeof data === "object") {
		lines.push(`object{${Object.keys(data).join(", ")}}`);
		for (const [k, val] of Object.entries(data)) {
			if (Array.isArray(val)) lines.push(`  ${k}: ${arrayDesc(val)}`);
		}
	} else {
		lines.push(JSON.stringify(data));
	}
	return lines.join("\n");
}

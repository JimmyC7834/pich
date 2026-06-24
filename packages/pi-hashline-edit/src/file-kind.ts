import { open as fsOpen, stat as fsStat } from "fs/promises";

const FILE_TYPE_SNIFF_BYTES = 8192;

// Magic-byte sniff for the four image types pi renders inline. Replaces the
// `file-type` package, which shipped hundreds of format signatures just for
// this; everything non-image falls through to the null-byte/UTF-8 binary check
// below (the same heuristic pi's built-in read tool uses).
function detectImageMime(b: Uint8Array): string | undefined {
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return "image/png";
	}
	if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
		return "image/gif"; // GIF87a / GIF89a
	}
	// WebP: "RIFF"<size>"WEBP"
	if (
		b.length >= 12 &&
		b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
		b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
	) {
		return "image/webp";
	}
	return undefined;
}

export type LoadedFile =
	| { kind: "directory" }
	| { kind: "image"; mimeType: string }
	| { kind: "text"; text: string; hadUtf8DecodeErrors?: true }
	| { kind: "binary"; description: string };

function hasNullByte(buffer: Uint8Array): boolean {
	return buffer.includes(0);
}

export async function loadFileKindAndText(
	filePath: string,
): Promise<LoadedFile> {
	const pathStat = await fsStat(filePath);
	if (pathStat.isDirectory()) {
		return { kind: "directory" };
	}
	if (!pathStat.isFile()) {
		return {
			kind: "binary",
			description: "unsupported file type",
		};
	}

	const fileHandle = await fsOpen(filePath, "r");
	try {
		const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(
			buffer,
			0,
			FILE_TYPE_SNIFF_BYTES,
			0,
		);
		if (bytesRead === 0) {
			return { kind: "text", text: "" };
		}

		const sample = buffer.subarray(0, bytesRead);
		const imageMime = detectImageMime(sample);
		if (imageMime !== undefined) {
			return { kind: "image", mimeType: imageMime };
		}
		if (hasNullByte(sample)) {
			return {
				kind: "binary",
				description: "null bytes detected",
			};
		}

		// Non-fatal decode, matching pi's built-in tools: invalid UTF-8 becomes
		// U+FFFD rather than rejecting the file. The null-byte guard above is the
		// only signal we treat as binary, so non-UTF-8 text (CP1251, GBK, …) reads
		// instead of forcing the model to bypass hashline with raw shell edits.
		// Track fatal-decoder failures separately so a literal, valid U+FFFD in a
		// UTF-8 file does not get mistaken for lossy decoding.
		const decoder = new TextDecoder("utf-8");
		const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
		let hadUtf8DecodeErrors = false;
		const noteUtf8DecodeErrors = (chunk?: Uint8Array): void => {
			if (hadUtf8DecodeErrors) return;
			try {
				fatalDecoder.decode(chunk, { stream: chunk !== undefined });
			} catch (error: unknown) {
				if (error instanceof TypeError) {
					hadUtf8DecodeErrors = true;
					return;
				}
				throw error;
			}
		};

		noteUtf8DecodeErrors(sample);
		const parts: string[] = [decoder.decode(sample, { stream: true })];

		let position = bytesRead;
		while (true) {
			const { bytesRead: chunkBytesRead } = await fileHandle.read(
				buffer,
				0,
				FILE_TYPE_SNIFF_BYTES,
				position,
			);
			if (chunkBytesRead === 0) {
				break;
			}

			const chunk = buffer.subarray(0, chunkBytesRead);
			if (hasNullByte(chunk)) {
				return {
					kind: "binary",
					description: "null bytes detected",
				};
			}
			noteUtf8DecodeErrors(chunk);
			parts.push(decoder.decode(chunk, { stream: true }));
			position += chunkBytesRead;
		}

		noteUtf8DecodeErrors();
		parts.push(decoder.decode());

		return {
			kind: "text",
			text: parts.join(""),
			...(hadUtf8DecodeErrors ? { hadUtf8DecodeErrors: true as const } : {}),
		};
	} finally {
		await fileHandle.close();
	}
}

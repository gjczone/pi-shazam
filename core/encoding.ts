/**
 * pi-shazam core/encoding -- Adaptive file encoding reader.
 *
 * Reads files with UTF-8 -> GBK -> GB2312 fallback.
 * Includes OOM protection via file size limits (2MB max) and
 * encoding validation on first 64KB chunk to reduce memory pressure.
 */

import { readFileSync, statSync } from "node:fs";
import { readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import iconv from "iconv-lite";

// Tree-sitter's MAX_PARSE_SIZE -- skip files larger than 2MB
// Lowered from 10MB to reduce OOM risk on resource-constrained environments
// (fixes #131, #148)
const MAX_FILE_SIZE = 2 * 1024 * 1024;

/**
 * Error thrown when a file exceeds the max allowed size.
 * Callers can check `instanceof FileTooLargeError` instead of
 * substring-matching the error message.
 */
export class FileTooLargeError extends Error {
	public readonly path: string;
	public readonly size: number;
	public readonly limit: number;

	constructor(path: string, size: number, limit: number) {
		super(`File too large (${size} bytes > ${limit}): ${path}`);
		this.name = "FileTooLargeError";
		this.path = path;
		this.size = size;
		this.limit = limit;
	}
}

// Chunk size for encoding validation -- only validate first 64KB
// to avoid allocating huge strings for large files
const VALIDATION_CHUNK_SIZE = 64 * 1024;

// -- Encoding detection and reading -------------------------------------------

/**
 * Read a file with adaptive encoding fallback:
 * 1. Try UTF-8
 * 2. Try GBK (cp936)
 * 3. Try GB2312
 *
 * Returns the decoded string content.
 * Throws if the file exceeds MAX_FILE_SIZE (2MB) to prevent OOM.
 * For encoding detection, validates only the first 64KB to avoid
 * allocating huge strings during multi-encoding fallback.
 */
export function readFileAdaptive(filePath: string): string {
	// Check file size before reading to prevent OOM
	let fileSize: number;
	try {
		const stat = statSync(filePath);
		fileSize = stat.size;
		if (fileSize > MAX_FILE_SIZE) {
			throw new FileTooLargeError(filePath, fileSize, MAX_FILE_SIZE);
		}
	} catch (err) {
		if (err instanceof FileTooLargeError) {
			throw err; // re-throw our size error
		}
		// Only warn for non-ENOENT errors (permission, I/O, etc.).
		// ENOENT is expected when callers read optional config files (e.g. package.json)
		// and handle the missing-file case via try/catch (#459).
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			console.warn(`[pi-shazam] readFileAdaptive: stat failed for ${filePath}: ${err}`);
		}
		// stat failed (permission, missing) -- fall through to readFileSync which will error with a clearer message
	}
	const buffer = readFileSync(filePath);

	// For small files (<64KB), validate full buffer
	// For larger files, validate only first chunk to reduce memory pressure
	const validationBuffer = buffer.length > VALIDATION_CHUNK_SIZE ? buffer.subarray(0, VALIDATION_CHUNK_SIZE) : buffer;

	// Try UTF-8 first
	const utf8Result = tryDecode(validationBuffer, "utf-8");
	if (utf8Result !== null) {
		// UTF-8 validation passed on chunk.
		// For large files, the first 64KB may be valid UTF-8 while later bytes
		// are GBK/GB2312 (#438). Decode full buffer as UTF-8, then check
		// replacement character ratio on the full decoded string. If >5%,
		// fall back to GBK -> GB2312 on the full buffer.
		if (buffer.length > VALIDATION_CHUNK_SIZE) {
			const fullUtf8 = buffer.toString("utf-8");
			if (_replacementRatio(fullUtf8) <= 0.05) return fullUtf8;

			const fullGbk = iconv.decode(buffer, "gbk");
			if (_replacementRatio(fullGbk) <= 0.05) return fullGbk;

			const fullGb = iconv.decode(buffer, "gb2312");
			if (_replacementRatio(fullGb) <= 0.05) return fullGb;

			return fullUtf8;
		}
		return utf8Result;
	}

	// Try GBK
	const gbkResult = tryDecode(validationBuffer, "gbk");
	if (gbkResult !== null) {
		return buffer.length > VALIDATION_CHUNK_SIZE ? iconv.decode(buffer, "gbk") : gbkResult;
	}

	// Try GB2312
	const gbResult = tryDecode(validationBuffer, "gb2312");
	if (gbResult !== null) {
		return buffer.length > VALIDATION_CHUNK_SIZE ? iconv.decode(buffer, "gb2312") : gbResult;
	}

	// Last resort: UTF-8 with replacement
	return buffer.toString("utf-8");
}

/**
 * Async variant of readFileAdaptive using fs.promises.
 * Same encoding fallback logic (UTF-8 -> GBK -> GB2312) but non-blocking.
 * Use this in async contexts (e.g., LSP enrichment) to avoid blocking the event loop.
 */
export async function readFileAdaptiveAsync(filePath: string): Promise<string> {
	// Check file size before reading to prevent OOM
	try {
		const stat = await statAsync(filePath);
		if (stat.size > MAX_FILE_SIZE) {
			throw new FileTooLargeError(filePath, stat.size, MAX_FILE_SIZE);
		}
	} catch (err) {
		if (err instanceof FileTooLargeError) {
			throw err;
		}
		// Only warn for non-ENOENT errors (permission, I/O, etc.).
		// ENOENT is expected when callers read optional config files (#459).
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			console.warn(`[pi-shazam] readFileAdaptiveAsync: stat failed for ${filePath}: ${err}`);
		}
		// stat failed -- fall through to readFile which will error with a clearer message
	}
	const buffer = await readFileAsync(filePath);

	// For small files (<64KB), validate full buffer
	// For larger files, validate only first chunk to reduce memory pressure
	const validationBuffer = buffer.length > VALIDATION_CHUNK_SIZE ? buffer.subarray(0, VALIDATION_CHUNK_SIZE) : buffer;

	// Try UTF-8 first
	const utf8Result = tryDecode(validationBuffer, "utf-8");
	if (utf8Result !== null) {
		// UTF-8 validation passed on chunk.
		// For large files, the first 64KB may be valid UTF-8 while later bytes
		// are GBK/GB2312 (#438). Decode full buffer as UTF-8, then check
		// replacement character ratio on the full decoded string. If >5%,
		// fall back to GBK -> GB2312 on the full buffer.
		if (buffer.length > VALIDATION_CHUNK_SIZE) {
			const fullUtf8 = buffer.toString("utf-8");
			if (_replacementRatio(fullUtf8) <= 0.05) return fullUtf8;

			const fullGbk = iconv.decode(buffer, "gbk");
			if (_replacementRatio(fullGbk) <= 0.05) return fullGbk;

			const fullGb = iconv.decode(buffer, "gb2312");
			if (_replacementRatio(fullGb) <= 0.05) return fullGb;

			return fullUtf8;
		}
		return utf8Result;
	}

	// Try GBK
	const gbkResult = tryDecode(validationBuffer, "gbk");
	if (gbkResult !== null) {
		return buffer.length > VALIDATION_CHUNK_SIZE ? iconv.decode(buffer, "gbk") : gbkResult;
	}

	// Try GB2312
	const gbResult = tryDecode(validationBuffer, "gb2312");
	if (gbResult !== null) {
		return buffer.length > VALIDATION_CHUNK_SIZE ? iconv.decode(buffer, "gb2312") : gbResult;
	}

	// Last resort: UTF-8 with replacement
	return buffer.toString("utf-8");
}

// -- Internal helpers ---------------------------------------------------------

/**
 * Validate that a buffer contains only valid UTF-8 byte sequences.
 * Performs byte-level validation: rejects overlong encodings, lone continuation
 * bytes, surrogates, and invalid lead bytes.
 *
 * Unlike the string-level U+FFFD check, this correctly handles source files
 * that legitimately contain the Unicode replacement character.
 */
function isValidUtf8(buffer: Buffer): boolean {
	let i = 0;
	while (i < buffer.length) {
		const byte = buffer[i]!;

		// ASCII (0x00-0x7F): single byte
		if (byte < 0x80) {
			i++;
			continue;
		}

		// Determine sequence length from lead byte
		let seqLen: number;
		if ((byte & 0xe0) === 0xc0) {
			seqLen = 2; // 110xxxxx
		} else if ((byte & 0xf0) === 0xe0) {
			seqLen = 3; // 1110xxxx
		} else if ((byte & 0xf8) === 0xf0) {
			seqLen = 4; // 11110xxx
		} else {
			// Lone continuation byte (0x80-0xBF) or invalid lead (0xFE-0xFF)
			return false;
		}

		// Ensure we have enough bytes remaining.
		// If the sequence extends past the buffer end, it may be boundary
		// truncation (the full file has the continuation bytes). Break
		// instead of returning false so the caller can retry with a
		// larger chunk or validate the full buffer (fixes #335).
		if (i + seqLen > buffer.length) break;

		// All continuation bytes must match 10xxxxxx
		for (let j = 1; j < seqLen; j++) {
			const cb = buffer[i + j]!;
			if ((cb & 0xc0) !== 0x80) return false;
		}

		// Reject overlong encodings and surrogates
		if (seqLen === 2) {
			const cp = ((byte & 0x1f) << 6) | (buffer[i + 1]! & 0x3f);
			if (cp < 0x80) return false; // overlong: could fit in 1 byte
		} else if (seqLen === 3) {
			const cp = ((byte & 0x0f) << 12) | ((buffer[i + 1]! & 0x3f) << 6) | (buffer[i + 2]! & 0x3f);
			if (cp < 0x800) return false; // overlong: could fit in 2 bytes
			if (cp >= 0xd800 && cp <= 0xdfff) return false; // surrogate
		} else if (seqLen === 4) {
			const cp =
				((byte & 0x07) << 18) |
				((buffer[i + 1]! & 0x3f) << 12) |
				((buffer[i + 2]! & 0x3f) << 6) |
				(buffer[i + 3]! & 0x3f);
			if (cp < 0x10000) return false; // overlong: could fit in 3 bytes
			if (cp > 0x10ffff) return false; // beyond Unicode range
		}

		i += seqLen;
	}
	return true;
}

/**
 * Compute the ratio of Unicode replacement characters (U+FFFD) in a string.
 * Returns 0-1.  Used to detect encoding misdetection for large files (#438).
 */
function _replacementRatio(str: string): number {
	if (str.length === 0) return 0;
	let count = 0;
	for (const ch of str) {
		if (ch === "\uFFFD") count++;
	}
	return count / str.length;
}

/**
 * Try to decode a buffer with a given encoding.
 * Returns the decoded string if successful, or null if invalid.
 */
function tryDecode(buffer: Buffer, encoding: string): string | null {
	try {
		if (encoding === "utf-8") {
			// Byte-level UTF-8 validation: preserves legitimate U+FFFD characters
			// while rejecting invalid byte sequences (#155).
			if (!isValidUtf8(buffer)) return null;
			return buffer.toString("utf-8");
		}

		// For iconv-lite encodings, decode and check for errors
		const str = iconv.decode(buffer, encoding);
		// Empty result with non-empty buffer: definitely wrong encoding
		if (str.length === 0 && buffer.length > 0) return null;
		// Replacement-character ratio check (#368): iconv-lite emits U+FFFD for
		// unmappable bytes.  If >5% of decoded characters are replacements,
		// the encoding is wrong -- reject to try the next fallback.
		if (_replacementRatio(str) > 0.05) return null;
		return str;
	} catch {
		console.warn("[pi-shazam] tryDecode: encoding decode failed");
		return null;
	}
}

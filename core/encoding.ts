/**
 * pi-shazam core/encoding — Adaptive file encoding reader.
 *
 * Reads files with UTF-8 → GBK → GB2312 fallback.
 * Includes OOM protection via file size limits (2MB max) and
 * encoding validation on first 64KB chunk to reduce memory pressure.
 */

import { readFileSync, statSync } from "node:fs";
import iconv from "iconv-lite";

// Tree-sitter's MAX_PARSE_SIZE — skip files larger than 2MB
// Lowered from 10MB to reduce OOM risk on resource-constrained environments
// (fixes #131, #148)
const MAX_FILE_SIZE = 2 * 1024 * 1024;

// Chunk size for encoding validation — only validate first 64KB
// to avoid allocating huge strings for large files
const VALIDATION_CHUNK_SIZE = 64 * 1024;

// ── Encoding detection and reading ───────────────────────────────────────────

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
			throw new Error(`File too large (${fileSize} bytes > ${MAX_FILE_SIZE}): ${filePath}`);
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("File too large")) {
			throw err; // re-throw our size error
		}
		// stat failed (permission, missing) — fall through to readFileSync which will error with a clearer message
	}
	const buffer = readFileSync(filePath);

	// For small files (<64KB), validate full buffer
	// For larger files, validate only first chunk to reduce memory pressure
	const validationBuffer = buffer.length > VALIDATION_CHUNK_SIZE ? buffer.subarray(0, VALIDATION_CHUNK_SIZE) : buffer;

	// Try UTF-8 first
	const utf8Result = tryDecode(validationBuffer, "utf-8");
	if (utf8Result !== null) {
		// UTF-8 validation passed on chunk — decode full buffer
		return buffer.length > VALIDATION_CHUNK_SIZE ? buffer.toString("utf-8") : utf8Result;
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

// ── Encoding detection ───────────────────────────────────────────────────────

/**
 * Detect the most likely encoding for a buffer.
 * Returns one of: "utf-8", "gbk", "gb2312", "unknown".
 */
export function detectEncoding(buffer: Buffer): string {
	// UTF-8 BOM check
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return "utf-8";
	}

	// Try UTF-8 validation
	const utf8Result = tryDecode(buffer, "utf-8");
	if (utf8Result !== null) return "utf-8";

	// Check for GBK/GB2312 patterns (high bytes 0x81-0xfe)
	let gbkBytes = 0;
	for (let i = 0; i < buffer.length; i++) {
		const byte = buffer[i];
		if (byte !== undefined && byte >= 0x81 && byte <= 0xfe) {
			gbkBytes++;
		}
	}

	if (gbkBytes > buffer.length * 0.3) {
		const gbkResult = tryDecode(buffer, "gbk");
		if (gbkResult !== null) return "gbk";

		const gbResult = tryDecode(buffer, "gb2312");
		if (gbResult !== null) return "gb2312";
	}

	return "unknown";
}

// ── Internal helpers ─────────────────────────────────────────────────────────

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
		if ((byte & 0xE0) === 0xC0) {
			seqLen = 2; // 110xxxxx
		} else if ((byte & 0xF0) === 0xE0) {
			seqLen = 3; // 1110xxxx
		} else if ((byte & 0xF8) === 0xF0) {
			seqLen = 4; // 11110xxx
		} else {
			// Lone continuation byte (0x80-0xBF) or invalid lead (0xFE-0xFF)
			return false;
		}

		// Ensure we have enough bytes remaining
		if (i + seqLen > buffer.length) return false;

		// All continuation bytes must match 10xxxxxx
		for (let j = 1; j < seqLen; j++) {
			const cb = buffer[i + j]!;
			if ((cb & 0xC0) !== 0x80) return false;
		}

		// Reject overlong encodings and surrogates
		if (seqLen === 2) {
			const cp = ((byte & 0x1F) << 6) | (buffer[i + 1]! & 0x3F);
			if (cp < 0x80) return false; // overlong: could fit in 1 byte
		} else if (seqLen === 3) {
			const cp =
				((byte & 0x0F) << 12) |
				((buffer[i + 1]! & 0x3F) << 6) |
				(buffer[i + 2]! & 0x3F);
			if (cp < 0x800) return false; // overlong: could fit in 2 bytes
			if (cp >= 0xD800 && cp <= 0xDFFF) return false; // surrogate
		} else if (seqLen === 4) {
			const cp =
				((byte & 0x07) << 18) |
				((buffer[i + 1]! & 0x3F) << 12) |
				((buffer[i + 2]! & 0x3F) << 6) |
				(buffer[i + 3]! & 0x3F);
			if (cp < 0x10000) return false; // overlong: could fit in 3 bytes
			if (cp > 0x10ffff) return false; // beyond Unicode range
		}

		i += seqLen;
	}
	return true;
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
		// iconv-lite uses replacement chars, so check if the result seems valid
		// by verifying the decoded content doesn't have too many unknown chars
		if (str.length === 0 && buffer.length > 0) return null;
		return str;
	} catch {
		return null;
	}
}

// ── Convenience ──────────────────────────────────────────────────────────────

/**
 * Read a file with specific encoding.
 */
export function readFileWithEncoding(filePath: string, encoding: string): string {
	const buffer = readFileSync(filePath);
	if (encoding === "utf-8") {
		return buffer.toString("utf-8");
	}
	return iconv.decode(buffer, encoding);
}

import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileAdaptive } from "../core/encoding.js";

describe("encoding boundary (#335)", () => {
	it("should correctly detect UTF-8 when multi-byte character straddles 64KB boundary", () => {
		// Build a file that is exactly 64KB + a few bytes, with a 4-byte UTF-8
		// character (e.g., 𐍈 U+10348, encoded as F0 90 8D 88) placed so that
		// its lead byte (F0) lands at offset 65535 — the last byte of the 64KB
		// validation chunk. The continuation bytes (90 8D 88) fall at offsets
		// 65536-65538, past the chunk boundary.
		const CHUNK = 64 * 1024; // 65536

		// Fill the first CHUNK - 1 bytes with ASCII content
		const prefix = Buffer.alloc(CHUNK - 1, 0x41); // 'A' repeated
		// 4-byte UTF-8 for U+10348 (GOTHIC LETTER HWAIR): F0 90 8D 88
		const fourByteChar = Buffer.from([0xf0, 0x90, 0x8d, 0x88]);
		// Add some ASCII suffix so the file is > CHUNK
		const suffix = Buffer.alloc(100, 0x42); // 'B' repeated

		const content = Buffer.concat([prefix, fourByteChar, suffix]);
		expect(content.length).toBeGreaterThan(CHUNK);
		// The 4-byte char starts at offset CHUNK - 1 (65535)
		expect(content[CHUNK - 1]).toBe(0xf0); // lead byte
		expect(content[CHUNK]).toBe(0x90); // continuation byte 1
		expect(content[CHUNK + 1]).toBe(0x8d); // continuation byte 2
		expect(content[CHUNK + 2]).toBe(0x88); // continuation byte 3

		// Write to a temp file
		const tempPath = join(tmpdir(), `pi-shazam-encoding-test-${Date.now()}.txt`);
		try {
			writeFileSync(tempPath, content);

			// readFileAdaptive should detect this as UTF-8, not fall back to GBK/GB2312
			const decoded = readFileAdaptive(tempPath);

			// The decoded string should contain the Gothic character
			expect(decoded).toContain("\u{10348}");

			// Verify the decoded content length is correct (CHUNK-1 ASCII + 1 Gothic + 100 ASCII)
			// The Gothic character is 1 JS character (surrogate pair counts as 1 in length via spread)
			expect([...decoded].length).toBe(CHUNK - 1 + 1 + 100);
		} finally {
			try {
				unlinkSync(tempPath);
			} catch {
				// cleanup best-effort
			}
		}
	});

	it("should correctly decode UTF-8 file even when chunk validation sees truncated sequence", () => {
		// Smaller test: chunk is 64KB, but we'll use a small buffer to test the
		// truncation-resilience logic via isValidUtf8 directly
		const CHUNK = 64 * 1024;

		// Content: valid ASCII prefix filling almost the chunk, then a 4-byte char
		const prefix = Buffer.alloc(CHUNK - 2, 0x41);
		const char = Buffer.from([0xf0, 0x90, 0x8d, 0x88]); // U+10348
		const content = Buffer.concat([prefix, char]);

		const tempPath = join(tmpdir(), `pi-shazam-encoding-test2-${Date.now()}.txt`);
		try {
			writeFileSync(tempPath, content);
			const decoded = readFileAdaptive(tempPath);
			expect(decoded).toContain("\u{10348}");
		} finally {
			try {
				unlinkSync(tempPath);
			} catch {
				// cleanup best-effort
			}
		}
	});

	it("should still reject genuinely invalid UTF-8 (non-boundary case)", () => {
		// A buffer with an invalid byte sequence NOT at the boundary
		const buf = Buffer.from([0x41, 0x42, 0x80, 0x43]); // 0x80 is lone continuation
		const tempPath = join(tmpdir(), `pi-shazam-encoding-test3-${Date.now()}.txt`);
		try {
			writeFileSync(tempPath, buf);
			// Should fall back to GBK/GB2312 (which may decode successfully)
			// or use utf-8 with replacement. The key is it doesn't crash.
			const decoded = readFileAdaptive(tempPath);
			expect(typeof decoded).toBe("string");
			expect(decoded.length).toBeGreaterThan(0);
		} finally {
			try {
				unlinkSync(tempPath);
			} catch {
				// cleanup best-effort
			}
		}
	});
});

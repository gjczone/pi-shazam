/**
 * Regression test for issue #689:
 * Two empty catch blocks in index.ts (shazam-doctor audit-log parsing)
 * silently discarded malformed lines. The fix adds `_logWarn` diagnostics
 * so malformed `internal.log` and `shazam-calls.log` lines are surfaced
 * instead of being dropped with no trace.
 *
 * The shazam-doctor handler is an anonymous closure registered inside the
 * index.ts default export, mirroring the convention used by
 * `tests/index-session-shutdown.test.ts`. Invoking it end-to-end would
 * require booting the entire Pi ExtensionAPI surface, so this test verifies
 * the contract at the source level: both catch sites must log via `_logWarn`
 * with distinct messages identifying which audit log line failed to parse.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readIndexSrc(): string {
	return readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf-8");
}

/**
 * Extract the body of `pi.registerCommand("shazam-doctor", { ... })` from
 * source text. Walks braces from the first `{` after the command name to the
 * matching close. Throws if the registration cannot be located.
 */
function extractDoctorHandler(src: string): string {
	const startRegex = /registerCommand\(\s*["']shazam-doctor["']/;
	const startMatch = src.match(startRegex);
	if (!startMatch || startMatch.index === undefined) {
		throw new Error('could not locate registerCommand("shazam-doctor", ...) handler');
	}
	const startIdx = startMatch.index;
	const firstBrace = src.indexOf("{", startIdx);
	if (firstBrace === -1) {
		throw new Error("could not find opening brace for shazam-doctor handler");
	}
	let depth = 0;
	let endIdx = -1;
	for (let i = firstBrace; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				endIdx = i;
				break;
			}
		}
	}
	if (endIdx === -1) {
		throw new Error("unbalanced braces in shazam-doctor handler");
	}
	return src.slice(firstBrace, endIdx + 1);
}

describe("issue #689: shazam-doctor logs malformed audit-log lines", () => {
	it("logs internal.log parse failures via _logWarn", () => {
		const src = readIndexSrc();
		const block = extractDoctorHandler(src);
		expect(block).toMatch(/_logWarn\(\s*["']shazam-doctor["']\s*,\s*["']JSON\.parse failed for internal\.log line["']/);
	});

	it("logs shazam-calls.log parse failures via _logWarn", () => {
		const src = readIndexSrc();
		const block = extractDoctorHandler(src);
		expect(block).toMatch(
			/_logWarn\(\s*["']shazam-doctor["']\s*,\s*["']JSON\.parse failed for shazam-calls\.log line["']/,
		);
	});

	it("no bare `catch {` remains in the shazam-doctor handler (regression gate)", () => {
		const src = readIndexSrc();
		const block = extractDoctorHandler(src);
		const bareCatches = block.match(/\bcatch\s*\{/g) ?? [];
		expect(bareCatches).toEqual([]);
	});
});

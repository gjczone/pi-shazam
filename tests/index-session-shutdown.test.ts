/**
 * Regression test for issue #548:
 * `clearRenameState()` was wired into the `session_start` handler but NOT
 * the `session_shutdown` handler. If `session_start` does not fire (crash
 * recovery, hot reload, process crash mid-session), the reviewed-symbols
 * `Set` persists across what the user expects to be a fresh session, and
 * the `shazam_rename_symbol` safety gate (`hasCallChainChecked`) can be
 * bypassed based on stale "call-chain-checked" state.
 *
 * This test uses static source analysis because the `session_shutdown`
 * handler is an anonymous closure registered inside the index.ts default
 * export — invoking it end-to-end would require mocking the entire Pi
 * ExtensionAPI surface. The contract being asserted is the wiring itself:
 * the call must exist inside the handler block.
 *
 * Companion behavioral coverage: `tests/rename-state.test.ts` verifies that
 * `clearRenameState()` does in fact clear `_reviewedSymbols`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readIndexSrc(): string {
	return readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf-8");
}

/**
 * Extract the body of a `pi.on("<event>", ...)` handler from source text.
 * Returns the source slice from the opening `pi.on(` through the closing `});`
 * of the handler. Throws if the handler cannot be located.
 */
function extractPiOnHandler(src: string, eventName: string): string {
	// Match: pi.on("eventName", async () => { ... });
	// The handler body may contain nested braces, so we walk braces from the
	// first `{` after the event-name argument to find the matching close.
	const startRegex = new RegExp(`pi\\.on\\(\\s*["']${eventName}["']`);
	const startMatch = src.match(startRegex);
	if (!startMatch || startMatch.index === undefined) {
		throw new Error(`could not locate pi.on("${eventName}", ...) handler`);
	}
	const startIdx = startMatch.index;

	// Find the first `{` after the pi.on( call.
	const firstBrace = src.indexOf("{", startIdx);
	if (firstBrace === -1) {
		throw new Error(`could not find opening brace for ${eventName} handler`);
	}

	// Walk braces until they balance.
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
		throw new Error(`unbalanced braces in ${eventName} handler`);
	}
	// Include the trailing `);` so the slice is the full handler registration.
	const tailIdx = src.indexOf(");", endIdx);
	const sliceEnd = tailIdx === -1 ? endIdx + 1 : tailIdx + 2;
	return src.slice(startIdx, sliceEnd);
}

describe("issue #548: session_shutdown clears rename state", () => {
	it("clearRenameState is called inside the session_shutdown handler", () => {
		const src = readIndexSrc();
		const shutdownBlock = extractPiOnHandler(src, "session_shutdown");
		expect(shutdownBlock, "session_shutdown handler must exist").toBeTruthy();
		expect(shutdownBlock).toMatch(/clearRenameState\s*\(\s*\)/);
	});

	it("clearRenameState is still called inside the session_start handler (defense in depth)", () => {
		// The fix must NOT remove the existing session_start call — both
		// lifecycle events should reset the state.
		const src = readIndexSrc();
		const startBlock = extractPiOnHandler(src, "session_start");
		expect(startBlock, "session_start handler must exist").toBeTruthy();
		expect(startBlock).toMatch(/clearRenameState\s*\(\s*\)/);
	});

	it("clearRenameState call site count in index.ts is at least 2 (grep gate)", () => {
		// Direct grep-style regression gate per the issue's acceptance criteria:
		// `grep -n "clearRenameState" index.ts` must show 2 call sites (was 1).
		const src = readIndexSrc();
		const callMatches = src.match(/clearRenameState\s*\(\s*\)/g) ?? [];
		expect(callMatches.length).toBeGreaterThanOrEqual(2);
	});
});

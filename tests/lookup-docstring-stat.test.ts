/**
 * Tests for issue #664: shazam_lookup's per-file docstring cache swallowed
 * statSync errors with a blank catch, hiding real filesystem problems
 * (EACCES/EPERM, transient I/O) and forcing a silent re-parse every lookup.
 *
 * The fix logs non-ENOENT stat failures via _logWarn while keeping the
 * ENOENT -> mtime=0 fallback silent (the file is expected to be gone).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../core/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/output.js")>();
	return { ...actual, _logWarn: logWarn };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

// Force the LSP-hover branch to be skipped so _extractDocstring (the target
// of fix #664) is actually reached. Return null so no hover is produced and
// the docstring fallback runs; lspDocumentSymbols(null,...) safely no-ops.
vi.mock("../tools/_context.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../tools/_context.js")>();
	return {
		...actual,
		getLspManager: () => null,
	};
});

import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";
import { executeLookupAsync } from "../tools/lookup.js";
import { statSync as statSyncMock } from "node:fs";
import { join } from "node:path";

let graph: RepoGraph;
// A symbol guaranteed to exist in the graph so the lookup reaches the
// docstring-extraction path (_getHoverInfo -> _extractDocstring).
const TEST_SYMBOL = "_logWarn";

beforeEach(() => {
	logWarn.mockClear();
	vi.mocked(statSyncMock).mockRestore();
	graph = scanProject(".");
});

afterEach(() => {
	vi.mocked(statSyncMock).mockRestore();
});

describe("issue #664: docstring cache logs non-ENOENT stat failures", () => {
	it("logs when statSync fails with a non-ENOENT error", async () => {
		const accessErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		vi.mocked(statSyncMock).mockImplementation(() => {
			throw accessErr;
		});

		await executeLookupAsync(graph, TEST_SYMBOL, join("core", "output.ts"), "both", false);

		// The docstring-cache stat failure must be surfaced (fix #664).
		const messages = logWarn.mock.calls.map((c) => String(c[1])).join(" ");
		expect(messages).toContain("statSync failed for");
	});

	it("does NOT log the docstring-stat failure for ENOENT (expected fallback)", async () => {
		const notFound = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		vi.mocked(statSyncMock).mockImplementation(() => {
			throw notFound;
		});

		await executeLookupAsync(graph, TEST_SYMBOL, join("core", "output.ts"), "both", false);

		// The ENOENT fallback must stay silent for the docstring stat.
		const messages = logWarn.mock.calls.map((c) => String(c[1])).join(" ");
		expect(messages).not.toContain("statSync failed for");
	});
});

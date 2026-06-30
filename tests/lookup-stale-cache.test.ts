/**
 * Tests for executeFileDetailAsync stale-cache warning banner (issue #557).
 *
 * When `statSync` fails inside the cache-validation block (file deleted,
 * permissions revoked, path race), the old code silently returned the
 * stale cached text -- the warning went only to the audit log, and the
 * LLM received no indication that the content might be outdated.
 *
 * The fix prepends a `[STALE CACHE WARNING]` banner to the returned text
 * so the LLM can see the staleness, while keeping graceful degradation
 * (cached content is still available if the LLM accepts the risk).
 *
 * Test strategy: use an existing project file (core/output.ts) which is
 * guaranteed to be in the scanner's graph. First call warms the cache
 * with real statSync; second call mocks statSync to throw to simulate
 * the file becoming inaccessible between calls.
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

import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";
import { executeFileDetailAsync } from "../tools/lookup.js";
import { statSync as statSyncMock } from "node:fs";

let graph: RepoGraph;

beforeEach(() => {
	logWarn.mockClear();
	vi.mocked(statSyncMock).mockRestore();
	graph = scanProject(".");
});

afterEach(() => {
	vi.mocked(statSyncMock).mockRestore();
});

const TEST_FILE = "core/output.ts";

describe("issue #557: stale cache warning banner on statSync failure", () => {
	it("prepends [STALE CACHE WARNING] when statSync fails on cache hit", async () => {
		// First call — real statSync, warms the cache.
		const first = await executeFileDetailAsync(graph, TEST_FILE);
		expect(first).toContain(`File: ${TEST_FILE}`);
		expect(first).not.toContain("[STALE CACHE WARNING]");

		// Second call — mock statSync to throw, simulating the file vanishing.
		const accessErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		vi.mocked(statSyncMock).mockImplementation(() => {
			throw accessErr;
		});

		const result = await executeFileDetailAsync(graph, TEST_FILE);

		// Banner must be present (was absent before fix — RED test).
		expect(result).toContain("[STALE CACHE WARNING]");
		expect(result).toContain("no longer accessible");
		// Cached content must still be there (graceful degradation).
		expect(result).toContain(`File: ${TEST_FILE}`);
		// _logWarn audit trail still fires.
		expect(logWarn).toHaveBeenCalled();
	});

	it("does NOT prepend banner when statSync succeeds and mtime matches (regression)", async () => {
		const first = await executeFileDetailAsync(graph, TEST_FILE);
		const second = await executeFileDetailAsync(graph, TEST_FILE);

		expect(second).not.toContain("[STALE CACHE WARNING]");
		expect(second).toBe(first);
	});
});

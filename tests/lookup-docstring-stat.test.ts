/**
 * Tests for issue #664: shazam_lookup's per-file docstring cache swallowed
 * statSync errors with a blank catch, hiding real filesystem problems
 * (EACCES/EPERM, transient I/O) and forcing a silent re-parse every lookup.
 *
 * The fix logs non-ENOENT stat failures via _logWarn while keeping the
 * ENOENT -> mtime=0 fallback silent (the file is expected to be gone).
 *
 * These tests call _extractDocstring directly so they do not depend on the
 * global project scan, getEffectiveRoot(), or validatePathInProject() -- all
 * of which vary by environment and made the earlier integration test flaky
 * on CI.
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

import { statSync as statSyncMock } from "node:fs";
import { _extractDocstring } from "../tools/lookup.js";

const TEST_FILE = "/nonexistent/proj/core/output.ts";

beforeEach(() => {
	logWarn.mockClear();
	vi.mocked(statSyncMock).mockRestore();
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

		// The stat failure must be surfaced (fix #664) even though the
		// subsequent read also fails -- the log happens before any read.
		_extractDocstring(TEST_FILE, 1);

		const messages = logWarn.mock.calls.map((c) => String(c[1])).join(" ");
		expect(messages).toContain("statSync failed for");
	});

	it("does NOT log the docstring-stat failure for ENOENT (expected fallback)", async () => {
		const notFound = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		vi.mocked(statSyncMock).mockImplementation(() => {
			throw notFound;
		});

		_extractDocstring(TEST_FILE, 1);

		// The ENOENT fallback must stay silent for the docstring stat.
		const messages = logWarn.mock.calls.map((c) => String(c[1])).join(" ");
		expect(messages).not.toContain("statSync failed for");
	});
});

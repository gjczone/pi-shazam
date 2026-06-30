/**
 * Regression tests for issue #552: infinite async recursion between writeJsonl
 * and _logWarn on persistent fs failure.
 *
 * Before the fix, writeJsonl's `.catch` called `_logWarn`, which itself called
 * `writeJsonl(INTERNAL_LOG_PATH, ...)` to persist the warning. On a persistent
 * non-ENOENT failure (EACCES, EROFS, ENOSPC), each iteration appended two
 * links to the `_writeMutex` promise chain -- unbounded growth, CPU spin, and
 * the original error never surfaced.
 *
 * The fix routes writeJsonl's catch to `console.error` directly (Option A) and
 * wraps ensureLogDir's mkdir in try/catch with `console.error`, breaking the
 * cycle because console.error does not re-enter writeJsonl.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub _logWarn so the current (buggy) writeJsonl catch does not re-enter
// writeJsonl via _logWarn -> writeJsonl(INTERNAL_LOG_PATH). This isolates the
// assertion: the catch must route to console.error, not _logWarn.
// eaccErr is hoisted because the fs/promises mock factory (also hoisted)
// references it at module-load time.
const { logWarnSpy, eaccErr } = vi.hoisted(() => ({
	logWarnSpy: vi.fn(),
	eaccErr: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
}));
vi.mock("../core/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/output.js")>();
	return {
		...actual,
		_logWarn: logWarnSpy,
	};
});

// Force every fs/promises write to reject with EACCES to simulate a persistent
// permission failure on the audit log directory (#552).
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		mkdir: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
		appendFile: vi.fn().mockRejectedValue(eaccErr),
		chmod: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		unlink: vi.fn().mockResolvedValue(undefined),
	};
});

import { writeJsonl } from "../core/audit-log.js";

describe("issue #552: writeJsonl breaks recursion on persistent fs failure", () => {
	beforeEach(() => {
		logWarnSpy.mockClear();
	});

	it("routes writeJsonl failure to console.error instead of _logWarn (no recursion)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		writeJsonl("/tmp/shazam-test-552.log", { event: "test" });
		// Flush the async mutex chain so the .catch handler runs.
		await new Promise((r) => setTimeout(r, 50));

		// After the fix: writeJsonl's catch calls console.error, NOT _logWarn.
		expect(errSpy).toHaveBeenCalled();

		// The original EACCES error must surface to console.error (not swallowed).
		const surfaced = errSpy.mock.calls.some((c) => {
			const joined = c.map((a) => (a instanceof Error ? a.message : String(a ?? ""))).join(" ");
			return joined.includes("EACCES");
		});
		expect(surfaced).toBe(true);

		// _logWarn must NOT be called from writeJsonl's catch -- that path would
		// re-enter writeJsonl(INTERNAL_LOG_PATH) and restart the recursion cycle.
		const writeJsonlLogCall = logWarnSpy.mock.calls.find(
			(c: unknown[]) => c[0] === "audit-log" && typeof c[1] === "string" && String(c[1]).includes("writeJsonl"),
		);
		expect(writeJsonlLogCall).toBeUndefined();

		errSpy.mockRestore();
	});
});

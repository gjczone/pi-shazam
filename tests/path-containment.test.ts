/**
 * Tests for cross-platform path-containment checks (issue #463).
 *
 * Background: validatePathInProject and autoFormatFile previously used
 * `resolved.startsWith(root + "/")` to confirm a path stayed inside the
 * project root. On Windows, `path.resolve()` returns backslash-separated
 * paths, so the forward-slash prefix never matched and EVERY valid subpath
 * was rejected. The fix replaces those checks with a `relative()`-based
 * `isPathInRoot` helper (mirroring the already-correct lsp/manager.ts).
 *
 * Note on Windows coverage: `node:path` binds to the HOST platform at module
 * load time (posix on Linux CI, win32 on Windows). We therefore test the
 * exported `isPathInRoot` directly with POSIX paths (real Linux behavior),
 * and verify the Windows case by exercising the same `relative()`+`isAbsolute()`
 * algorithm through `path.win32` (the semantics Windows would use). This
 * reproduces the original bug with the old `startsWith(root + "/")` approach
 * and proves the new algorithm resolves it.
 */
import { describe, it, expect, vi } from "vitest";
import { win32, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { isPathInRoot, validatePathInProject } from "../tools/_factory.js";

describe("isPathInRoot (exported helper)", () => {
	it("returns true for a subpath inside the root (POSIX)", () => {
		expect(isPathInRoot("/proj/src/foo.ts", "/proj")).toBe(true);
	});

	it("returns true when target equals root", () => {
		// relative() returns "" when target === root, which means "inside".
		expect(isPathInRoot("/proj", "/proj")).toBe(true);
	});

	it("returns false for a path traversal escape", () => {
		// /etc/passwd resolves outside /proj -> relative starts with "..".
		expect(isPathInRoot("/etc/passwd", "/proj")).toBe(false);
	});

	it("returns false for a sibling directory sharing a name prefix", () => {
		// Guards against the classic startsWith-without-separator pitfall:
		// "/proj-evil" must NOT be treated as inside "/proj".
		expect(isPathInRoot("/proj-evil/foo.ts", "/proj")).toBe(false);
	});

	it("returns false for an absolute path on a different drive (POSIX-style)", () => {
		expect(isPathInRoot("/var/log/foo.ts", "/proj")).toBe(false);
	});
});

describe("validatePathInProject (end-to-end on real POSIX paths)", () => {
	it("accepts a file that exists inside a real temp project root", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-shazam-pc-"));
		try {
			writeFileSync(join(tmp, "foo.ts"), "export const x = 1;\n");
			// Relative raw path resolved against the temp root must be accepted.
			expect(validatePathInProject("foo.ts", tmp)).toBe(true);
			// Absolute resolved path inside root must also be accepted.
			expect(validatePathInProject(join(tmp, "foo.ts"), tmp)).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("accepts the project root itself", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-shazam-pc-"));
		try {
			// "." resolves to the root; relative() === "" -> inside.
			expect(validatePathInProject(".", tmp)).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects a relative path that escapes the project root (../etc/passwd)", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-shazam-pc-"));
		try {
			// Resolves to <parent>/etc/passwd which is outside the temp root.
			expect(validatePathInProject("../etc/passwd", tmp)).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects an absolute path outside the project root", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-shazam-pc-"));
		try {
			expect(validatePathInProject("/etc/passwd", tmp)).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("returns false silently for ENOENT (missing file does NOT log a warning) -- issue #632 UX", () => {
		// When an agent asks for a path that does not exist on disk (the common
		// negative-probe case), validatePathInProject must return false and
		// must NOT emit a stderr line. A "realpathSync failed for ..." warning
		// on every miss is user-visible noise (#632 UX principle: status /
		// observation notes belong in the LLM context, not stderr).
		const tmp = mkdtempSync(join(tmpdir(), "pi-shazam-pc-enoent-"));
		try {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				expect(validatePathInProject("does-not-exist.ts", tmp)).toBe(false);
				const calls = warnSpy.mock.calls.map((c) => c.join(" "));
				const offending = calls.find((m) => /realpathSync failed/i.test(m));
				expect(offending, `unexpected console.warn: ${JSON.stringify(offending)}`).toBeUndefined();
			} finally {
				warnSpy.mockRestore();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("Windows path-containment regression (#463)", () => {
	it("reproduces the bug: old startsWith(root + '/') rejects valid Windows subpaths", () => {
		// This is the exact buggy check that was in validatePathInProject /
		// autoFormatFile. On Windows, resolve() yields backslash-separated
		// paths, so appending a forward slash never matches.
		const root = "C:\\proj";
		const target = "C:\\proj\\src\\foo.ts";
		expect(target.startsWith(root + "/")).toBe(false);
	});

	it("verifies the fix algorithm accepts Windows subpaths via win32 semantics", () => {
		// The isPathInRoot algorithm uses relative() + isAbsolute(). Under
		// win32 semantics (what a Windows host actually uses), a subpath of
		// the root produces a relative path that does not start with ".."
		// and is not absolute -> correctly accepted.
		const root = "C:\\proj";
		const target = "C:\\proj\\src\\foo.ts";
		const rel = win32.relative(root, target);
		const accepted = rel === "" || (!rel.startsWith("..") && !win32.isAbsolute(rel));
		expect(accepted).toBe(true);
		expect(rel).toBe("src\\foo.ts");
	});

	it("verifies the fix algorithm rejects Windows path-traversal via win32 semantics", () => {
		const root = "C:\\proj";
		const target = "C:\\windows\\system32\\evil.dll";
		const rel = win32.relative(root, target);
		const accepted = rel === "" || (!rel.startsWith("..") && !win32.isAbsolute(rel));
		expect(accepted).toBe(false);
	});
});

describe("autoFormatFile containment check (#463)", () => {
	// autoFormatFile is not exported, but its containment guard now delegates
	// to isPathInRoot. Verify the helper directly covers the cases the hook
	// relies on (relative subpath accepted, traversal rejected).
	it("accepts a relative subpath resolved against the project root", () => {
		// Mirrors autoFormatFile: absPath = join(cwd, "src/foo.ts").
		const projectRoot = "/proj";
		const absPath = join(projectRoot, "src/foo.ts");
		expect(isPathInRoot(absPath, projectRoot)).toBe(true);
	});

	it("rejects a path that resolves outside the project root", () => {
		const projectRoot = "/proj";
		const absPath = "/etc/passwd";
		expect(isPathInRoot(absPath, projectRoot)).toBe(false);
	});
});

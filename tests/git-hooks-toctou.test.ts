/**
 * Tests for core/git-hooks TOCTOU resilience (issue #462, finding #3).
 *
 * Verifies that existsSync + readFileSync races do not throw unhandled
 * exceptions. When a file is deleted between the existence check and the
 * read, the functions must degrade gracefully instead of crashing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoisted state: paths that should simulate TOCTOU race.
// existsSync returns true (file physically exists), but readFileSync throws
// ENOENT to simulate the file being deleted between the two calls.
const { racePaths, errorCodeMap } = vi.hoisted(() => ({
	racePaths: new Set<string>(),
	errorCodeMap: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
			const path = String(args[0]);
			if (racePaths.has(path)) {
				const code = errorCodeMap.get(path) || "ENOENT";
				const err = new Error(`${code}: error, open '${path}'`) as NodeJS.ErrnoException;
				err.code = code;
				throw err;
			}
			return actual.readFileSync(...args);
		}),
		// #604: Track chmodSync calls so the win32 guard can be asserted.
		// installPreCommitHook's chmod call routes through this spy; the real
		// chmod behavior is irrelevant for these tests (no assertions rely on
		// the executable bit being set on the temp hook file).
		chmodSync: vi.fn(),
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: vi.fn((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			// Return hooks dir path for "git rev-parse --git-path hooks"
			if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--git-path" && args[2] === "hooks") {
				const cwd = (opts?.cwd as string) || ".";
				return `${join(cwd, ".git/hooks")}\n`;
			}
			// For git diff in runPreCommitVerify, return empty (no staged changes)
			if (cmd === "git" && args[0] === "diff") {
				return "";
			}
			return "";
		}),
	};
});

// Import AFTER mocks are set up.
// readFileSync is mocked but passes through to real impl for non-race paths,
// so it can be used to verify file contents in assertions.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { installPreCommitHook, isPreCommitHookInstalled, removePreCommitHook } from "../core/git-hooks.js";

let tmpDir: string;
let hooksDir: string;

beforeEach(() => {
	racePaths.clear();
	errorCodeMap.clear();
	vi.mocked(chmodSync).mockClear();
	tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-githooks-"));
	hooksDir = join(tmpDir, ".git", "hooks");
	mkdirSync(hooksDir, { recursive: true });
});

afterEach(() => {
	racePaths.clear();
	errorCodeMap.clear();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe("installPreCommitHook: TOCTOU resilience (#462)", () => {
	it("should not throw when existing hook is deleted between existsSync and readFileSync", () => {
		const hookPath = join(hooksDir, "pre-commit");
		// File physically exists (existsSync=true), but readFileSync will throw
		writeFileSync(hookPath, "# custom hook", "utf-8");
		racePaths.add(hookPath);

		// Must not throw -- should treat as no existing hook and proceed
		expect(() => installPreCommitHook(tmpDir)).not.toThrow();
	});

	it("should install the hook successfully after tolerating the race", () => {
		const hookPath = join(hooksDir, "pre-commit");
		writeFileSync(hookPath, "# custom hook", "utf-8");
		racePaths.add(hookPath);

		const result = installPreCommitHook(tmpDir);
		expect(result).toBe(hookPath);
	});
});

describe("isPreCommitHookInstalled: TOCTOU resilience (#462)", () => {
	it("should return false (not throw) when hook is deleted between existsSync and readFileSync", () => {
		const hookPath = join(hooksDir, "pre-commit");
		writeFileSync(hookPath, "# shazam hook content", "utf-8");
		racePaths.add(hookPath);

		const result = isPreCommitHookInstalled(tmpDir);
		expect(result).toBe(false);
	});

	it("should still return true for a readable shazam hook (no race)", () => {
		const hookPath = join(hooksDir, "pre-commit");
		writeFileSync(hookPath, "# shazam pre-commit hook", "utf-8");
		// No race path added -- readFileSync succeeds normally

		expect(isPreCommitHookInstalled(tmpDir)).toBe(true);
	});

	it("should return false for a readable non-shazam hook (no race)", () => {
		const hookPath = join(hooksDir, "pre-commit");
		writeFileSync(hookPath, "# custom hook from another tool", "utf-8");

		expect(isPreCommitHookInstalled(tmpDir)).toBe(false);
	});

	it("should not log a warning when hook file is genuinely missing (#551 local guard)", () => {
		// The hook file is not created -- readFileSync throws ENOENT naturally.
		// The local ENOENT guard at core/git-hooks.ts must suppress _logWarn so
		// the missing-hook probe stays silent (issue #551 removed the blanket
		// global suppression in _logWarn; genuinely-expected ENOENT is now
		// handled by per-call-site guards).
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = isPreCommitHookInstalled(tmpDir);
		expect(result).toBe(false);
		// No warning: the local guard skips _logWarn for ENOENT.
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

describe("removePreCommitHook: TOCTOU resilience (#462)", () => {
	it("should return false (not throw) when hook is deleted between existsSync and readFileSync", () => {
		const hookPath = join(hooksDir, "pre-commit");
		writeFileSync(hookPath, "# shazam hook", "utf-8");
		racePaths.add(hookPath);

		const result = removePreCommitHook(tmpDir);
		expect(result).toBe(false);
	});

	it("should handle backup file deleted between existsSync and readFileSync", () => {
		const hookPath = join(hooksDir, "pre-commit");
		const backupPath = join(hooksDir, "pre-commit.shazam-backup");
		// Hook is readable (contains shazam), but backup read fails
		writeFileSync(hookPath, "# shazam hook", "utf-8");
		writeFileSync(backupPath, "# original hook", "utf-8");
		racePaths.add(backupPath);

		// Should not throw -- should fall back to removing the hook
		expect(() => {
			const result = removePreCommitHook(tmpDir);
			expect(result).toBe(true);
		}).not.toThrow();
	});

	it("should restore backup when no race occurs", () => {
		const hookPath = join(hooksDir, "pre-commit");
		const backupPath = join(hooksDir, "pre-commit.shazam-backup");
		writeFileSync(hookPath, "# shazam hook", "utf-8");
		writeFileSync(backupPath, "# original custom hook", "utf-8");

		const result = removePreCommitHook(tmpDir);
		expect(result).toBe(true);
		// Backup content should now be in hookPath (readFileSync passes through
		// to real impl since hookPath is not in racePaths)
		expect(readFileSync(hookPath, "utf-8")).toContain("original custom hook");
	});
});

describe("non-ENOENT error handling (#534)", () => {
	it("installPreCommitHook should throw on EACCES reading existing hook", () => {
		const hookPath = join(hooksDir, "pre-commit");
		writeFileSync(hookPath, "# custom hook", "utf-8");
		racePaths.add(hookPath);
		errorCodeMap.set(hookPath, "EACCES");

		expect(() => installPreCommitHook(tmpDir)).toThrow();
	});

	it("isPreCommitHookInstalled should return false on non-ENOENT error", () => {
		const hookPath = join(hooksDir, "pre-commit");
		writeFileSync(hookPath, "# shazam hook", "utf-8");
		racePaths.add(hookPath);
		errorCodeMap.set(hookPath, "EACCES");

		const result = isPreCommitHookInstalled(tmpDir);
		expect(result).toBe(false);
	});

	it("removePreCommitHook should return false on non-ENOENT error reading hook", () => {
		const hookPath = join(hooksDir, "pre-commit");
		writeFileSync(hookPath, "# shazam hook", "utf-8");
		racePaths.add(hookPath);
		errorCodeMap.set(hookPath, "EACCES");

		const result = removePreCommitHook(tmpDir);
		expect(result).toBe(false);
	});

	it("removePreCommitHook should NOT unlink hook on non-ENOENT error reading backup", () => {
		const hookPath = join(hooksDir, "pre-commit");
		const backupPath = join(hooksDir, "pre-commit.shazam-backup");
		writeFileSync(hookPath, "# shazam hook", "utf-8");
		writeFileSync(backupPath, "# original hook", "utf-8");
		racePaths.add(backupPath);
		errorCodeMap.set(backupPath, "EACCES");

		const result = removePreCommitHook(tmpDir);
		expect(result).toBe(true);
		expect(readFileSync(hookPath, "utf-8")).toContain("shazam hook");
	});
});

describe("PRE_COMMIT_HOOK_CONTENT: cross-platform Node script (#604)", () => {
	it("writes a #!/usr/bin/env node shebang, not bash", () => {
		const hookPath = installPreCommitHook(tmpDir);
		const content = readFileSync(hookPath, "utf-8");
		expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
		expect(content).not.toContain("#!/bin/bash");
	});

	it("contains the shazam marker so isPreCommitHookInstalled still detects it", () => {
		const hookPath = installPreCommitHook(tmpDir);
		const content = readFileSync(hookPath, "utf-8");
		expect(content).toContain("shazam");
		expect(isPreCommitHookInstalled(tmpDir)).toBe(true);
	});

	it("resolves project root via `git rev-parse --show-toplevel` (worktree-safe)", () => {
		const hookPath = installPreCommitHook(tmpDir);
		const content = readFileSync(hookPath, "utf-8");
		expect(content).toContain('"--show-toplevel"');
		// The old bash version used `$(dirname "$0")/../..` which pointed at
		// `.git`, not the worktree root, on worktree checkouts.
		expect(content).not.toContain('dirname "$0"');
	});

	it("uses execFileSync for every child call, no shell pipelines", () => {
		const hookPath = installPreCommitHook(tmpDir);
		const content = readFileSync(hookPath, "utf-8");
		expect(content).toContain("execFileSync(");
		expect(content).not.toContain("| tail");
		expect(content).not.toContain("2>/dev/null");
	});

	it("skips chmodSync on win32 (Node hook is launched via shebang, no exec bit needed)", () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			installPreCommitHook(tmpDir);
			expect(chmodSync).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("applies chmodSync on POSIX platforms", () => {
		if (process.platform === "win32") return; // skip on win32 hosts
		installPreCommitHook(tmpDir);
		expect(chmodSync).toHaveBeenCalled();
	});
});

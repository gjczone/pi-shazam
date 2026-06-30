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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { installPreCommitHook, isPreCommitHookInstalled, removePreCommitHook } from "../core/git-hooks.js";

let tmpDir: string;
let hooksDir: string;

beforeEach(() => {
	racePaths.clear();
	errorCodeMap.clear();
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

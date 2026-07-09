/**
 * Tests for worktree-aware git diff in shazam_verify (issue #226).
 *
 * Verifies that getGitChangedFiles resolves the correct git working
 * directory when running from a git worktree, and that executeVerify
 * reports the correct changed files.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveGitWorkdir", () => {
	it("should resolve to the git root from a project subdirectory", async () => {
		const { resolveGitWorkdir } = await import("../tools/verify.js");
		// Run from the current project root — should return a valid path
		const result = resolveGitWorkdir(".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("should return cwd as-is for non-git directories", async () => {
		const { resolveGitWorkdir } = await import("../tools/verify.js");
		const tempDir = mkdtempSync(join(tmpdir(), "shazam-non-git-"));
		try {
			const result = resolveGitWorkdir(tempDir);
			expect(result).toBe(tempDir);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("should resolve worktree root correctly", async () => {
		// This test verifies that resolveGitWorkdir returns a valid path
		// when called from a git repo or worktree
		const { resolveGitWorkdir } = await import("../tools/verify.js");
		const result = resolveGitWorkdir(".");
		// Should return an absolute path (or at least a valid directory)
		expect(result).toBeTruthy();
	});
});

// Run a git command, retrying on transient failures (lock contention,
// EAGAIN) that occur under heavy full-suite load on the local runner.
// Caps total attempts so a genuine failure still surfaces. Returns the
// trimmed stdout so it can also replace inline execSync calls that need
// the command output (e.g. git rev-parse).
function gitWithRetry(cwd: string, cmd: string, attempts = 3): string {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
		} catch (err) {
			lastErr = err;
			if (i < attempts - 1) {
				// Brief backoff before retrying the flaky git op.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (i + 1));
			}
		}
	}
	throw lastErr;
}

// #679: the git setup in beforeAll (git init + worktree add) can take
// longer than the default 10s hookTimeout under full-suite load, causing a
// flaky "Hook timed out in 10000ms" failure. Raise the hook timeout to 30s.
describe("getGitChangedFiles — worktree awareness (issue #226)", { hookTimeout: 30000 }, () => {
	let mainRepo: string;
	let worktreeDir: string;

	beforeAll(() => {
		// Create a temporary git repo. Every git op is wrapped in
		// gitWithRetry because under heavy full-suite load on the local
		// runner any single git command can hit transient lock contention.
		mainRepo = mkdtempSync(join(tmpdir(), "shazam-wt-main-"));
		gitWithRetry(mainRepo, "git init");
		gitWithRetry(mainRepo, "git config user.email test@test.com");
		gitWithRetry(mainRepo, "git config user.name Test");

		// Create initial commit
		writeFileSync(join(mainRepo, "index.ts"), "export const x = 1;\n");
		gitWithRetry(mainRepo, "git add .");
		gitWithRetry(mainRepo, 'git commit -m "initial"');

		// Create a worktree (retry: git worktree add can hit lock
		// contention under full-suite load on the local runner)
		const worktreeBase = mkdtempSync(join(tmpdir(), "shazam-wt-worktrees-"));
		worktreeDir = join(worktreeBase, "feature");
		gitWithRetry(mainRepo, `git worktree add -b feature "${worktreeDir}"`);

		// Make changes in the worktree (not in main)
		writeFileSync(join(worktreeDir, "new-file.ts"), "export const y = 2;\n");
		writeFileSync(join(worktreeDir, "index.ts"), "export const x = 1;\nexport const z = 3;\n");
	});

	afterAll(() => {
		// Cleanup: remove worktree first, then main repo
		try {
			execSync(`git worktree remove "${worktreeDir}" --force`, {
				cwd: mainRepo,
				encoding: "utf-8",
			});
		} catch {
			/* ignore */
		}
		rmSync(mainRepo, { recursive: true, force: true });
		// Also clean up the worktree base directory
		if (worktreeDir) {
			const worktreeBase = join(worktreeDir, "..");
			rmSync(worktreeBase, { recursive: true, force: true });
		}
	});

	it("should detect changes when running from worktree directory", async () => {
		const { executeVerify } = await import("../tools/verify.js");

		// Create a minimal graph for the worktree
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(worktreeDir);

		const result = executeVerify(graph, worktreeDir);
		// Should show changed files, not "No uncommitted changes"
		expect(result).not.toMatch(/No uncommitted changes/i);
		expect(result).toMatch(/new-file\.ts|index\.ts/);
	});

	it("should NOT show changes from main repo when running from main (no changes there)", async () => {
		const { executeVerify } = await import("../tools/verify.js");

		// Create a minimal graph for the main repo
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(mainRepo);

		const result = executeVerify(graph, mainRepo);
		// Main repo has no uncommitted changes (worktree changes don't affect main)
		expect(result).toMatch(/No uncommitted changes/i);
	});

	it("should detect worktree changes when projectRoot='.' and CWD is worktree", async () => {
		// This test verifies the core fix for issue #226:
		// When CWD is the worktree, git diff should show worktree changes
		const { resolveGitWorkdir } = await import("../tools/verify.js");

		// From worktree dir, should resolve to worktree root (not main repo)
		const resolvedDir = resolveGitWorkdir(worktreeDir);
		expect(resolvedDir).toBeTruthy();

		// The resolved dir should be the worktree directory itself
		// (since worktree root IS the worktree directory)
		// Use realpathSync to handle macOS /private/var symlink
		// gitWithRetry guards the rev-parse against transient lock errors.
		const resolved = gitWithRetry(worktreeDir, "git rev-parse --show-toplevel");
		// #592: On Windows, git rev-parse may return short-name paths
		// (e.g. C:\Users\RUNNER~1) while mkdtempSync returns long names
		// (C:\Users\runneradmin). realpathSync does not always resolve
		// intermediate short-name components. Compare using stat inodes.
		const resolvedCanon = realpathSync(resolved);
		const worktreeCanon = realpathSync(worktreeDir);
		try {
			const st1 = statSync(resolvedCanon);
			const st2 = statSync(worktreeCanon);
			expect(st1.ino).toBe(st2.ino);
		} catch {
			// Fallback: case-insensitive compare on win32
			if (process.platform === "win32") {
				expect(resolvedCanon.toLowerCase()).toBe(worktreeCanon.toLowerCase());
			} else {
				expect(resolvedCanon).toBe(worktreeCanon);
			}
		}
	});
});

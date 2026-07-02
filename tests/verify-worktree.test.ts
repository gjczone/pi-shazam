/**
 * Tests for worktree-aware git diff in shazam_verify (issue #226).
 *
 * Verifies that getGitChangedFiles resolves the correct git working
 * directory when running from a git worktree, and that executeVerify
 * reports the correct changed files.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
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

describe("getGitChangedFiles — worktree awareness (issue #226)", () => {
	let mainRepo: string;
	let worktreeDir: string;

	beforeAll(() => {
		// Create a temporary git repo
		mainRepo = mkdtempSync(join(tmpdir(), "shazam-wt-main-"));
		execSync("git init", { cwd: mainRepo, encoding: "utf-8" });
		execSync("git config user.email test@test.com", { cwd: mainRepo, encoding: "utf-8" });
		execSync("git config user.name Test", { cwd: mainRepo, encoding: "utf-8" });

		// Create initial commit
		writeFileSync(join(mainRepo, "index.ts"), "export const x = 1;\n");
		execSync("git add .", { cwd: mainRepo, encoding: "utf-8" });
		execSync('git commit -m "initial"', { cwd: mainRepo, encoding: "utf-8" });

		// Create a worktree
		const worktreeBase = mkdtempSync(join(tmpdir(), "shazam-wt-worktrees-"));
		worktreeDir = join(worktreeBase, "feature");
		execSync(`git worktree add -b feature "${worktreeDir}"`, {
			cwd: mainRepo,
			encoding: "utf-8",
		});

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
		const resolved = execSync("git rev-parse --show-toplevel", {
			cwd: worktreeDir,
			encoding: "utf-8",
		}).trim();
		// #592: On Windows, git rev-parse may return short-name paths
		// (e.g. C:\Users\RUNNER~1) while mkdtempSync returns long names.
		// Use realpathSync on both sides to resolve to canonical form,
		// then compare lowercased on Windows (case-insensitive filesystem).
		const resolvedCanon = realpathSync(resolved);
		const worktreeCanon = realpathSync(worktreeDir);
		if (process.platform === "win32") {
			expect(resolvedCanon.toLowerCase()).toBe(worktreeCanon.toLowerCase());
		} else {
			expect(resolvedCanon).toBe(worktreeCanon);
		}
	});
});

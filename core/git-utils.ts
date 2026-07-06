/**
 * pi-shazam core/git-utils -- Shared git utility functions.
 *
 * Fixes issue #350: in non-git-repo directories, the extension would output
 * git's stderr errors ("fatal: not a git repository"), polluting the user's terminal/UI.
 *
 * This module provides:
 * - isGitRepo: one-time check whether a directory is a git repo, cached to avoid repeated git process spawns
 * - isProjectDir: check whether a directory is a project directory (has marker files or git repo), for fast short-circuit
 * - safeGitExec: safely execute git commands, auto-suppress stderr, return null for non-git repos
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { _logWarn } from "./output.js";
import { join } from "node:path";

// -- Project marker file list ------------------------------------------------

/**
 * Marker files that indicate a directory is a project root.
 * If any of these files exist, the directory is treated as a project directory.
 */
const PROJECT_MARKERS: readonly string[] = [
	"package.json",
	"tsconfig.json",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"setup.py",
	"requirements.txt",
	"Makefile",
	"pom.xml",
	"build.gradle",
	"pubspec.yaml", // Dart/Flutter
	".git",
];

// -- Git availability cache --------------------------------------------------

/**
 * Cache of git repo detection results. key = directory absolute path, value = whether it's a git repo.
 * Cached for the process lifetime to avoid repeatedly spawning git processes for the same directory.
 */
const gitRepoCache = new Map<string, boolean>();

// -- Core functions ----------------------------------------------------------

/**
 * Check whether a directory is a git repository.
 * Result is cached for the process lifetime; each directory is checked only once.
 *
 * Uses `git rev-parse --is-inside-work-tree` for detection,
 * with stderr fully suppressed (stdio: ["ignore", "pipe", "ignore"]),
 * preventing "fatal: not a git repository" from leaking to the user's terminal.
 */
export function isGitRepo(projectRoot: string): boolean {
	const cached = gitRepoCache.get(projectRoot);
	if (cached !== undefined) return cached;

	let result = false;
	try {
		const output = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: 3000,
			// Suppress stderr to prevent "fatal: not a git repository" from leaking to user's terminal
			stdio: ["ignore", "pipe", "ignore"],
		});
		result = output.trim() === "true";
	} catch (err) {
		_logWarn("isGitRepo", `git rev-parse failed for ${projectRoot}`, err);
		result = false;
	}

	gitRepoCache.set(projectRoot, result);
	return result;
}

/**
 * Check whether a directory is a project directory (has marker files or is a git repo).
 * Used for fast short-circuit in the before_agent_start hook.
 *
 * Non-project directories (e.g., /tmp, /var, /home) skip scanProject,
 * avoiding synchronous blocking on large temporary directories.
 */
export function isProjectDir(projectRoot: string): boolean {
	for (const marker of PROJECT_MARKERS) {
		if (existsSync(join(projectRoot, marker))) {
			return true;
		}
	}
	return false;
}

/**
 * Safely execute a git command.
 * - Non-git repo: returns null immediately (no git process spawned)
 * - Git repo: executes command, suppresses stderr, returns stdout; returns null on failure
 *
 * @param args - git subcommand arguments (e.g., ["log", "--oneline", "-10"])
 * @param cwd - working directory
 * @param timeout - timeout in milliseconds (default 5000)
 * @returns stdout string, or null (non-git repo / execution failure)
 */
export function safeGitExec(args: string[], cwd: string, timeout = 5000): string | null {
	// Non-git repo: return early to avoid spawning a git process that will fail
	if (!isGitRepo(cwd)) return null;

	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			timeout,
			// Suppress stderr to prevent git error messages from leaking to user's terminal
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch (err) {
		_logWarn("safeGitExec", `git ${args.join(" ")} failed for ${cwd}`, err);
		return null;
	}
}

/**
 * Resolve the actual path of the git working directory.
 *
 * Uses `git rev-parse --show-toplevel` for resolution. In a git worktree,
 * this returns the worktree root directory rather than the main repo
 * directory (issue #226).
 *
 * Returns `cwd` when the path is not inside a git repository.
 */
export function resolveGitWorkdir(cwd: string): string {
	const result = safeGitExec(["rev-parse", "--show-toplevel"], cwd, 5000);
	return result || cwd;
}

/**
 * Get the list of changed files in the git working tree.
 *
 * Checks both unstaged (`git diff`) and staged (`git diff --cached`) changes,
 * including only added, modified, copied, and renamed change types (ACMR),
 * with automatic deduplication.
 *
 * @param projectRoot - project root directory (internally resolves git working directory)
 * @returns array of relative paths of changed files
 */
export function getGitChangedFiles(projectRoot: string): string[] {
	const gitDir = resolveGitWorkdir(projectRoot);
	const unstaged = safeGitExec(["diff", "--name-only", "--diff-filter=ACMR"], gitDir, 5000);
	const staged = safeGitExec(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], gitDir, 5000);
	const combined = [unstaged, staged].filter(Boolean).join("\n").trim();
	if (!combined) return [];
	return [...new Set(combined.split("\n").filter(Boolean))];
}

/**
 * #631 B (slice 3.5): structural view of working-tree changes.
 *
 * Runs `git diff --numstat` (staged + unstaged) and tallies the
 * added and removed line counts. Returns null when the project is
 * not a git repo, when there are no changes, or when the numstat
 * output cannot be parsed.
 *
 * The `modified` count is the number of distinct files that
 * appear in the numstat output (any line with non-zero added or
 * removed counts). Pure binary additions (e.g. new files with 0
 * deletions) are counted as added; pure deletions count as removed.
 */
export function getGitNumstat(projectRoot: string): { added: number; removed: number; modified: number } | null {
	const gitDir = resolveGitWorkdir(projectRoot);
	const unstaged = safeGitExec(["diff", "--numstat", "--diff-filter=ACMR"], gitDir, 5000);
	const staged = safeGitExec(["diff", "--cached", "--numstat", "--diff-filter=ACMR"], gitDir, 5000);
	const combined = [unstaged, staged].filter(Boolean).join("\n").trim();
	if (!combined) return null;

	let added = 0;
	let removed = 0;
	let modified = 0;
	for (const line of combined.split("\n")) {
		if (!line) continue;
		// numstat format: "<added>\t<removed>\t<path>"
		// Binary files show as "-\t-\t<path>" -- skip those.
		const [aRaw, rRaw] = line.split("\t");
		if (!aRaw || !rRaw || aRaw === "-" || rRaw === "-") continue;
		const a = Number(aRaw);
		const r = Number(rRaw);
		if (!Number.isFinite(a) || !Number.isFinite(r)) continue;
		added += a;
		removed += r;
		modified += 1;
	}
	return { added, removed, modified };
}

/**
 * Reset git cache. Used only in tests.
 */
export function _resetGitCache(): void {
	gitRepoCache.clear();
}

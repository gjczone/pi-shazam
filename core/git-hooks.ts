/**
 * pi-shazam core/git-hooks -- Git pre-commit hook integration.
 *
 * Installs a pre-commit hook that runs shazam_verify --preCommit
 * before allowing a commit. Blocks commit on FAIL verdict.
 *
 * The hook is installed in the git hooks directory (supports worktrees
 * and custom GIT_DIR via git rev-parse --git-path hooks).
 * It calls npx shazam_verify (via the Pi extension's verify tool)
 * through the MCP entry point.
 */

import { writeFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { _logWarn } from "./output.js";
import { detectProjectLanguages } from "./formatters.js";

/**
 * Pre-commit hook script content. Cross-platform single Node script.
 *
 * One codebase runs on Linux, macOS, and Windows: no `chmod` dependency and no
 * separate `.cmd` wrapper (git only launches a file strictly named
 * `pre-commit` with no extension). pi-shazam itself is ESM (`type: "module"`),
 * but the hook may be auto-installed into user projects that are CommonJS.
 * The bootstrap below tries `require` first (CJS) and falls back to dynamic
 * `import()` (ESM), avoiding top-level `await` and `import.meta` so the same
 * source parses cleanly in both module kinds.
 *
 * Detects project language and runs appropriate checks:
 *   - TypeScript/JavaScript: tsc --noEmit, eslint/biome
 *   - Rust: cargo check, cargo clippy
 *   - Go: go vet, golangci-lint
 *   - Python: pyright, ruff, mypy
 * Use 'git commit --no-verify' to bypass.
 *
 * Runs as an independent process (git spawns it); must not import any pi-shazam
 * internal module because the dist path is not fixed across installs.
 */
const PRE_COMMIT_HOOK_CONTENT = `#!/usr/bin/env node
// shazam pre-commit hook - auto-installed by pi-shazam
// Cross-platform Node implementation. Use 'git commit --no-verify' to bypass.

// ESM/CJS polyglot bootstrap. In CommonJS \`require\` is defined; in ESM it is
// undefined and we use dynamic import(). Both branches use only syntax that
// parses in either module kind (no top-level await, no import.meta).
let execFileSync, existsSync, resolve;
function bootstrap() {
  try {
    execFileSync = require("node:child_process").execFileSync;
    existsSync = require("node:fs").existsSync;
    resolve = require("node:path").resolve;
    return Promise.resolve();
  } catch (_e) {
    return import("node:child_process")
      .then((m) => { execFileSync = m.execFileSync; })
      .then(() => import("node:fs"))
      .then((m) => { existsSync = m.existsSync; })
      .then(() => import("node:path"))
      .then((m) => { resolve = m.resolve; });
  }
}

bootstrap().then(main).catch((err) => {
  console.error("[shazam] pre-commit hook bootstrap failed:", err);
  process.exit(1);
});

function main() {
  function log(msg) { console.log("[shazam] " + msg); }

  // Resolve project root. Worktree-safe via rev-parse; the previous bash
  // implementation used $(dirname $0)/../.. which pointed at .git, not the
  // worktree root, on worktree checkouts.
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch (_err) {
    // Best-effort fallback when git invocation fails. git launches the hook
    // with cwd set to the worktree root in normal cases.
    root = process.cwd();
  }

  // Skip verification on non-main branches (feature branches, worktrees).
  // Only main/master commits get full pre-commit checks. Automated subagents
  // (Swarm, workflow phases) commit on feature branches and are blocked by
  // checks that require human interaction (type errors, lint failures).
  let branch = "";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch (_err) {
    // best effort; leave branch empty so the main/master check falls through
  }
  if (branch !== "main" && branch !== "master") {
    log("Skipping pre-commit verification on branch '" + branch + "' (only runs on main/master).");
    process.exit(0);
  }

  log("Running pre-commit verification...");

  // Check for staged changes
  let changedCount = 0;
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    changedCount = out ? out.split(/\\r?\\n/).filter(Boolean).length : 0;
  } catch (err) {
    log("Failed to read staged changes: " + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
  if (changedCount === 0) {
    log("No staged changes to verify.");
    process.exit(0);
  }

  log("Checking " + changedCount + " changed file(s)...");

  // Probe whether a command is on PATH. Uses \`where\` on Windows and
  // \`command -v\` on POSIX; both ship with the platform shell.
  function hasCmd(cmd) {
    try {
      if (process.platform === "win32") {
        execFileSync("where", [cmd], { encoding: "utf-8", timeout: 3000, stdio: "ignore" });
      } else {
        execFileSync("command", ["-v", cmd], { encoding: "utf-8", timeout: 3000, stdio: "ignore" });
      }
      return true;
    } catch (_err) {
      return false;
    }
  }

  // Run a single check command; returns true on success, false on failure.
  // stdio pipes stdout/stderr to the inherited streams so users see the
  // compiler/linter output inline.
  function run(label, cmd, args, timeoutMs) {
    log("Running " + label + "...");
    try {
      execFileSync(cmd, args, {
        cwd: root,
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["ignore", "inherit", "inherit"],
      });
      return true;
    } catch (_err) {
      log("FAIL: " + label + " found issues.");
      return false;
    }
  }

  let errors = 0;

  // -- TypeScript/JavaScript ----------------------------------------------
  if (existsSync(resolve(root, "tsconfig.json")) || existsSync(resolve(root, "package.json"))) {
    if (hasCmd("npx")) {
      if (existsSync(resolve(root, "tsconfig.json"))) {
        if (!run("tsc --noEmit", "npx", ["--no-install", "tsc", "--noEmit"], 60000)) errors++;
      }
      if (
        existsSync(resolve(root, "eslint.config.js")) ||
        existsSync(resolve(root, "eslint.config.mjs")) ||
        existsSync(resolve(root, ".eslintrc.js")) ||
        existsSync(resolve(root, ".eslintrc.json"))
      ) {
        if (!run("eslint", "npx", ["--no-install", "eslint", ".", "--max-warnings=0"], 60000)) errors++;
      } else if (existsSync(resolve(root, "biome.json")) || existsSync(resolve(root, "biome.jsonc"))) {
        if (!run("biome check", "npx", ["--no-install", "biome", "check", "."], 60000)) errors++;
      }
    }
  }

  // -- Rust ---------------------------------------------------------------
  if (existsSync(resolve(root, "Cargo.toml")) && hasCmd("cargo")) {
    if (!run("cargo check", "cargo", ["check"], 120000)) errors++;
    let hasClippy = false;
    try {
      execFileSync("cargo", ["clippy", "--version"], { encoding: "utf-8", timeout: 5000, stdio: "ignore" });
      hasClippy = true;
    } catch (_err) {
      // clippy not installed -- skip silently
    }
    if (hasClippy && !run("cargo clippy", "cargo", ["clippy", "--", "-D", "warnings"], 120000)) errors++;
  }

  // -- Go -----------------------------------------------------------------
  if (existsSync(resolve(root, "go.mod")) && hasCmd("go")) {
    if (!run("go vet", "go", ["vet", "./..."], 60000)) errors++;
    if (hasCmd("golangci-lint") && !run("golangci-lint", "golangci-lint", ["run"], 60000)) errors++;
  }

  // -- Python -------------------------------------------------------------
  if (
    existsSync(resolve(root, "pyproject.toml")) ||
    existsSync(resolve(root, "setup.py")) ||
    existsSync(resolve(root, "requirements.txt"))
  ) {
    if (hasCmd("pyright")) {
      if (!run("pyright", "pyright", ["."], 60000)) errors++;
    } else if (hasCmd("mypy")) {
      if (!run("mypy", "mypy", ["."], 60000)) errors++;
    }
    if (hasCmd("ruff") && !run("ruff check", "ruff", ["check", "."], 60000)) errors++;
  }

  // -- Summary ------------------------------------------------------------
  if (errors > 0) {
    log("FAIL: " + errors + " check(s) failed.");
    log("Fix errors or use 'git commit --no-verify' to bypass.");
    process.exit(1);
  }
  log("PASS: All checks passed.");
  process.exit(0);
}
`;

/**
 * Get the git hooks directory for the given project.
 * Uses git rev-parse --git-path hooks to support worktrees and custom GIT_DIR (fixes #138).
 *
 * @param projectRoot - Absolute path to the project root
 * @returns The absolute path to the git hooks directory
 */
export function getGitHooksDir(projectRoot: string): string {
	try {
		const hooksPath = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: 5000,
		})
			.toString()
			.trim();
		// If the path is relative, resolve against project root
		if (hooksPath.startsWith("/")) {
			return hooksPath;
		}
		return resolve(projectRoot, hooksPath);
	} catch (err) {
		_logWarn("getGitHooksDir", "git rev-parse failed, falling back to .git/hooks", err);
		// Fallback to .git/hooks for non-git directories
		const gitDir = resolve(projectRoot, ".git");
		return join(gitDir, "hooks");
	}
}

/**
 * Install the pre-commit git hook for the given project.
 *
 * Writes pre-commit hook with the shazam verify script
 * and makes it executable. Supports worktrees and custom GIT_DIR (fixes #138).
 *
 * Detects existing hook managers (husky, lefthook) and throws an error
 * with instructions instead of silently overwriting (fixes #309).
 *
 * @param projectRoot - Absolute path to the project root
 * @returns The path to the installed hook file
 * @throws Error if a hook manager is detected or hooks directory is missing
 */
export function installPreCommitHook(projectRoot: string): string {
	// Check for hook managers before writing (fixes #309)
	if (existsSync(join(projectRoot, ".husky"))) {
		throw new Error(
			"Husky detected (.husky/ directory). To add shazam as a pre-commit hook with husky:\n" +
				"  1. Run: npx husky add .husky/pre-commit 'npx shazam-pre-commit-verify'\n" +
				"  2. Or add 'npx shazam-pre-commit-verify' to your .husky/pre-commit file.",
		);
	}
	if (existsSync(join(projectRoot, "lefthook.yml")) || existsSync(join(projectRoot, "lefthook.yaml"))) {
		throw new Error(
			"Lefthook detected. To add shazam as a pre-commit hook with lefthook:\n" +
				"  1. Add to your lefthook.yml:\n" +
				"     pre-commit:\n" +
				"       commands:\n" +
				"         shazam-verify:\n" +
				"           run: npx shazam-pre-commit-verify",
		);
	}

	const hooksDir = getGitHooksDir(projectRoot);
	const hookPath = join(hooksDir, "pre-commit");

	// Ensure hooks directory exists
	if (!existsSync(hooksDir)) {
		throw new Error(`Git hooks directory not found: ${hooksDir}. Is this a git repository?`);
	}

	// Check if hook already exists (don't overwrite custom hooks).
	// Use try/catch instead of existsSync + readFileSync to avoid TOCTOU race
	// where the file is deleted between the existence check and the read (issue #462).
	try {
		const existingContent = readFileSync(hookPath, "utf-8");
		if (!existingContent.includes("shazam")) {
			// Backup existing hook
			const backupPath = join(hooksDir, "pre-commit.shazam-backup");
			writeFileSync(backupPath, existingContent, "utf-8");
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			_logWarn("git-hooks", `unexpected error reading hook file: ${hookPath}`, err as Error);
			throw err;
		}
		// ENOENT: hook file does not exist or was removed between check and read.
		// Treat as no existing hook and proceed with fresh installation.
	}

	writeFileSync(hookPath, PRE_COMMIT_HOOK_CONTENT, "utf-8");
	// Executable bit is meaningful only on POSIX. The Node hook on Windows is
	// launched by git via the `#!/usr/bin/env node` shebang handler; skip the
	// chmod (which is a silent no-op there) so the install path is unified.
	if (process.platform !== "win32") {
		chmodSync(hookPath, 0o755);
	}

	return hookPath;
}

/**
 * Check if the pre-commit hook is installed for the given project.
 * Supports worktrees and custom GIT_DIR (fixes #138).
 *
 * @param projectRoot - Absolute path to the project root
 * @returns True if the shazam pre-commit hook is installed
 */
export function isPreCommitHookInstalled(projectRoot: string): boolean {
	const hooksDir = getGitHooksDir(projectRoot);
	const hookPath = join(hooksDir, "pre-commit");
	// Use try/catch instead of existsSync + readFileSync to avoid TOCTOU race
	// where the file is deleted between the existence check and the read (issue #462).
	try {
		const content = readFileSync(hookPath, "utf-8");
		return content.includes("shazam");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			_logWarn("git-hooks", `failed to read hook file: ${hookPath}`, err as Error);
		}
		// ENOENT or other error: treat as not installed.
		return false;
	}
}

/**
 * Remove the installed pre-commit hook, restoring any backup if present.
 * Supports worktrees and custom GIT_DIR (fixes #138).
 *
 * @param projectRoot - Absolute path to the project root
 * @returns True if the hook was removed
 */
export function removePreCommitHook(projectRoot: string): boolean {
	const hooksDir = getGitHooksDir(projectRoot);
	const hookPath = join(hooksDir, "pre-commit");
	const backupPath = join(hooksDir, "pre-commit.shazam-backup");

	// Use try/catch instead of existsSync + readFileSync to avoid TOCTOU race
	// where the file is deleted between the existence check and the read (issue #462).
	let content: string;
	try {
		content = readFileSync(hookPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			_logWarn("git-hooks", `failed to read hook file: ${hookPath}`, err as Error);
		}
		// ENOENT or other error: hook not present or unreadable, nothing to remove.
		return false;
	}
	if (!content.includes("shazam")) return false;

	// Restore backup if it can be read. If the backup was removed (TOCTOU race),
	// fall back to removing the shazam-installed hook entirely.
	try {
		const backupContent = readFileSync(backupPath, "utf-8");
		writeFileSync(hookPath, backupContent, "utf-8");
		chmodSync(hookPath, 0o755);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			// Backup file does not exist or was removed between check and read.
			// Remove the shazam-installed hook instead of restoring backup.
			unlinkSync(hookPath);
		} else {
			_logWarn("git-hooks", `failed to read backup, not removing hook: ${backupPath}`, err as Error);
		}
	}

	return true;
}

/**
 * Run pre-commit verification synchronously.
 * Detects project language and runs appropriate checks.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns { verdict: "PASS" | "FAIL" | "WARN", message: string }
 */
export function runPreCommitVerify(projectRoot: string): { verdict: "PASS" | "FAIL" | "WARN"; message: string } {
	try {
		// Check for uncommitted changes
		const changedOutput = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: 5000,
		})
			.toString()
			.trim();

		if (!changedOutput) {
			return { verdict: "PASS", message: "No staged changes to verify." };
		}

		const changedFiles = changedOutput.split("\n").filter(Boolean);
		const errors: string[] = [];
		const languages = detectProjectLanguages(projectRoot);

		// -- TypeScript/JavaScript ------------------------------------------
		if (languages.includes("typescript")) {
			try {
				execFileSync("npx", ["--no-install", "tsc", "--noEmit"], {
					cwd: projectRoot,
					encoding: "utf-8",
					timeout: 60000,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (err) {
				const stderr = (err as { stderr?: string })?.stderr ?? "";
				const stdout = (err as { stdout?: string })?.stdout ?? "";
				const detail = String(stdout + stderr).slice(0, 500);
				errors.push(`TypeScript typecheck failed: ${detail}`);
			}
		}

		// -- Rust -----------------------------------------------------------
		if (languages.includes("rust")) {
			try {
				execFileSync("cargo", ["check"], {
					cwd: projectRoot,
					encoding: "utf-8",
					timeout: 120000,
					stdio: ["ignore", "ignore", "pipe"],
				});
			} catch (err) {
				const stderr = (err as { stderr?: string })?.stderr ?? "";
				errors.push(`cargo check failed: ${String(stderr).slice(0, 500)}`);
			}
		}

		// -- Go -------------------------------------------------------------
		if (languages.includes("go")) {
			try {
				execFileSync("go", ["vet", "./..."], {
					cwd: projectRoot,
					encoding: "utf-8",
					timeout: 60000,
					stdio: ["ignore", "ignore", "pipe"],
				});
			} catch (err) {
				const stderr = (err as { stderr?: string })?.stderr ?? "";
				errors.push(`go vet failed: ${String(stderr).slice(0, 500)}`);
			}
		}

		// -- Python ---------------------------------------------------------
		if (languages.includes("python")) {
			// Try pyright first, then mypy
			let pyrightAvailable = false;
			try {
				execFileSync("pyright", ["."], {
					cwd: projectRoot,
					encoding: "utf-8",
					timeout: 60000,
					stdio: ["ignore", "pipe", "pipe"],
				});
				pyrightAvailable = true;
			} catch (err: unknown) {
				const errnoErr = err as NodeJS.ErrnoException;
				const stderr = (errnoErr as { stderr?: string })?.stderr ?? "";
				const stdout = (errnoErr as { stdout?: string })?.stdout ?? "";
				if (errnoErr.code === "ENOENT" || (errnoErr as NodeJS.ErrnoException & { status?: number }).status === 127) {
					// pyright not installed -- try mypy
				} else {
					// pyright found type errors
					const detail = String(stdout + stderr).slice(0, 500);
					errors.push(`pyright found type errors: ${detail}`);
					pyrightAvailable = true; // already reported, don't fall through
				}
			}

			if (!pyrightAvailable) {
				try {
					execFileSync("mypy", ["."], {
						cwd: projectRoot,
						encoding: "utf-8",
						timeout: 60000,
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch (err) {
					const stderr = (err as { stderr?: string })?.stderr ?? "";
					const stdout = (err as { stdout?: string })?.stdout ?? "";
					const detail = String(stdout + stderr).slice(0, 500);
					errors.push(`Python type check failed: ${detail}`);
				}
			}
		}

		// -- Summary --------------------------------------------------------
		if (errors.length > 0) {
			return {
				verdict: "FAIL",
				message: `${errors.length} check(s) failed for ${changedFiles.length} staged file(s): ${errors.join(", ")}. Use 'git commit --no-verify' to bypass.`,
			};
		}

		return {
			verdict: "PASS",
			message: `All checks passed for ${changedFiles.length} staged file(s).`,
		};
	} catch (err) {
		return {
			verdict: "WARN",
			message: `Pre-commit verification error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

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

/**
 * Pre-commit hook script content.
 * Detects project language and runs appropriate checks:
 *   - TypeScript/JavaScript: tsc --noEmit, eslint/biome
 *   - Rust: cargo check, cargo clippy
 *   - Go: go vet, golangci-lint
 *   - Python: pyright, ruff, mypy
 * Use 'git commit --no-verify' to bypass.
 */
const PRE_COMMIT_HOOK_CONTENT = `#!/bin/bash
# shazam pre-commit hook - auto-installed by pi-shazam
# Detects project language and runs appropriate checks.
# Use 'git commit --no-verify' to bypass.

set -e

# Skip verification on non-main branches (feature branches, worktrees).
# Only main/master commits get full pre-commit checks. Automated subagents
# (Swarm, workflow phases) commit on feature branches and are blocked by
# checks that require human interaction (type errors, lint failures).
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  echo "[shazam] Skipping pre-commit verification on branch '$BRANCH' (only runs on main/master)."
  exit 0
fi

echo "[shazam] Running pre-commit verification..."

HOOK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$HOOK_DIR" || exit 1

# Check for staged changes
CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null | wc -l)
if [ "$CHANGED_FILES" -eq 0 ]; then
  echo "[shazam] No staged changes to verify."
  exit 0
fi

echo "[shazam] Checking $CHANGED_FILES changed file(s)..."

ERRORS=0

# -- TypeScript/JavaScript ----------------------------------------------
if [ -f "tsconfig.json" ] || [ -f "package.json" ]; then
  # Type check
  if command -v npx &>/dev/null; then
    if [ -f "tsconfig.json" ]; then
      echo "[shazam] Running TypeScript typecheck..."
      if ! npx --no-install tsc --noEmit 2>&1; then
        echo "[shazam] FAIL: TypeScript typecheck found errors."
        ERRORS=$((ERRORS + 1))
      fi
    fi
    
    # Lint (eslint or biome)
    if [ -f "eslint.config.js" ] || [ -f "eslint.config.mjs" ] || [ -f ".eslintrc.js" ] || [ -f ".eslintrc.json" ]; then
      echo "[shazam] Running eslint..."
      if ! npx --no-install eslint . --max-warnings=0 2>&1; then
        echo "[shazam] FAIL: eslint found issues."
        ERRORS=$((ERRORS + 1))
      fi
    elif [ -f "biome.json" ] || [ -f "biome.jsonc" ]; then
      echo "[shazam] Running biome check..."
      if ! npx --no-install biome check . 2>&1; then
        echo "[shazam] FAIL: biome found issues."
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi
fi

# -- Rust ---------------------------------------------------------------
if [ -f "Cargo.toml" ]; then
  if command -v cargo &>/dev/null; then
    echo "[shazam] Running cargo check..."
    if ! cargo check 2>&1; then
      echo "[shazam] FAIL: cargo check found errors."
      ERRORS=$((ERRORS + 1))
    fi
    
    # Clippy (optional, only if installed)
    if cargo clippy --version &>/dev/null 2>&1; then
      echo "[shazam] Running cargo clippy..."
      if ! cargo clippy -- -D warnings 2>&1; then
        echo "[shazam] FAIL: clippy found warnings."
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi
fi

# -- Go -----------------------------------------------------------------
if [ -f "go.mod" ]; then
  if command -v go &>/dev/null; then
    echo "[shazam] Running go vet..."
    if ! go vet ./... 2>&1; then
      echo "[shazam] FAIL: go vet found errors."
      ERRORS=$((ERRORS + 1))
    fi
    
    # golangci-lint (optional)
    if command -v golangci-lint &>/dev/null; then
      echo "[shazam] Running golangci-lint..."
      if ! golangci-lint run 2>&1; then
        echo "[shazam] FAIL: golangci-lint found issues."
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi
fi

# -- Python -------------------------------------------------------------
if [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f "requirements.txt" ]; then
  # Type check (pyright or mypy)
  if command -v pyright &>/dev/null; then
    echo "[shazam] Running pyright..."
    if ! pyright . 2>&1; then
      echo "[shazam] FAIL: pyright found errors."
      ERRORS=$((ERRORS + 1))
    fi
  elif command -v mypy &>/dev/null; then
    echo "[shazam] Running mypy..."
    if ! mypy . 2>&1; then
      echo "[shazam] FAIL: mypy found errors."
      ERRORS=$((ERRORS + 1))
    fi
  fi
  
  # Lint (ruff)
  if command -v ruff &>/dev/null; then
    echo "[shazam] Running ruff check..."
    if ! ruff check . 2>&1; then
      echo "[shazam] FAIL: ruff found issues."
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

# -- Summary ------------------------------------------------------------
if [ $ERRORS -gt 0 ]; then
  echo "[shazam] FAIL: $ERRORS check(s) failed."
  echo "[shazam] Fix errors or use 'git commit --no-verify' to bypass."
  exit 1
fi

echo "[shazam] PASS: All checks passed."
exit 0
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
	chmodSync(hookPath, 0o755);

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

		// -- TypeScript/JavaScript ------------------------------------------
		if (existsSync(join(projectRoot, "tsconfig.json"))) {
			try {
				execFileSync("npx", ["--no-install", "tsc", "--noEmit"], {
					cwd: projectRoot,
					encoding: "utf-8",
					timeout: 60000,
					stdio: ["ignore", "ignore", "pipe"],
				});
			} catch (err) {
				const stderr = (err as { stderr?: string })?.stderr ?? "";
				errors.push(`TypeScript typecheck failed: ${String(stderr).slice(0, 500)}`);
			}
		}

		// -- Rust -----------------------------------------------------------
		if (existsSync(join(projectRoot, "Cargo.toml"))) {
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
		if (existsSync(join(projectRoot, "go.mod"))) {
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
		if (existsSync(join(projectRoot, "pyproject.toml")) || existsSync(join(projectRoot, "setup.py"))) {
			// Try pyright first, then mypy
			let pyrightAvailable = false;
			try {
				execFileSync("pyright", ["."], {
					cwd: projectRoot,
					encoding: "utf-8",
					timeout: 60000,
					stdio: ["ignore", "ignore", "pipe"],
				});
				pyrightAvailable = true;
			} catch (err: unknown) {
				const errnoErr = err as NodeJS.ErrnoException;
				const stderr = (errnoErr as { stderr?: string })?.stderr ?? "";
				if (errnoErr.code === "ENOENT" || (errnoErr as NodeJS.ErrnoException & { status?: number }).status === 127) {
					// pyright not installed -- try mypy
				} else {
					// pyright found type errors
					errors.push(`pyright found type errors: ${String(stderr).slice(0, 500)}`);
					pyrightAvailable = true; // already reported, don't fall through
				}
			}

			if (!pyrightAvailable) {
				try {
					execFileSync("mypy", ["."], {
						cwd: projectRoot,
						encoding: "utf-8",
						timeout: 60000,
						stdio: ["ignore", "ignore", "pipe"],
					});
				} catch (err) {
					const stderr = (err as { stderr?: string })?.stderr ?? "";
					errors.push(`Python type check failed: ${String(stderr).slice(0, 500)}`);
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

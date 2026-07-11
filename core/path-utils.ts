/**
 * File-path classification for tool input validation.
 *
 * Before this helper existed, every dispatcher called `validatePathInProject`
 * and reported "outside the project root" for two distinct failure modes:
 *
 *   1. **Path traversal** -- `../../etc/passwd` is genuinely outside root.
 *   2. **File missing**   -- `src/foo.ts` is a valid relative path but the
 *      file does not exist in the project. `validatePathInProject` returns
 *      false here too because `realpathSync` throws ENOENT.
 *
 * The two failures require different recovery actions from the LLM agent:
 * traversal means the input is malicious (or wrong project); missing means
 * a typo. Conflating them wastes a turn (issue #636).
 *
 * `classifyFilePath` separates the three outcomes so each dispatcher can
 * emit a precise error message and, when appropriate, a "did you mean"
 * suggestion drawn from the graph's known file set.
 *
 * Lives in `core/` because it has zero dependencies on Pi/MCP/tooling --
 * the original `validatePathInProject` lives in `tools/_factory.ts` and
 * this module intentionally re-implements the pure parts so `core/`
 * stays import-free of `tools/`.
 */
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, isAbsolute, sep as pathSep } from "node:path";
import { homedir } from "node:os";
import { getEffectiveRoot } from "./scanner.js";

// Issue #673: Windows/Git-Bash path normalization.
//
// On Windows, a Git-Bash user passes `/c/Users/foo` and a WSL user passes
// `/mnt/c/Users/foo`. Node's `realpathSync`/`statSync` treat `/c/...` as a
// relative path and throw ENOENT. `normalizePathInput` translates both
// styles to `C:\Users\foo` before any fs call touches them.
//
// The target runtime is Windows-native (including `.exe` packaging), so
// all user-supplied paths MUST be normalized at ingress. Call this before
// `realpathSync`/`statSync`/`lspawn` on any user input.

/**
 * Normalize a user-supplied path for the current platform.
 *
 * On win32, translates Git-Bash `/c/foo` and WSL `/mnt/c/foo` to `C:\foo`.
 * On other platforms the input is returned unchanged.
 *
 * See `normalizePathInputForPlatform` for the platform-parameterized core.
 */
export function normalizePathInput(input: string): string {
	return normalizePathInputForPlatform(input, process.platform);
}

/**
 * Platform-parameterized core of `normalizePathInput`. Exposed so tests can
 * exercise the Git-Bash/WSL translation logic on every CI platform, not
 * just Windows runners.
 *
 * Translation rules (win32 only; no-op elsewhere):
 *   - `/c/Users/foo`     (Git-Bash) -> `C:\Users\foo`
 *   - `/mnt/c/Users/foo` (WSL)      -> `C:\Users\foo`
 *   - `C:\Users\foo`                -> unchanged
 *   - `src/foo.ts`                  -> unchanged (relative)
 *   - `/home/user/proj`             -> unchanged (not a drive pattern)
 *
 * The first path segment must be exactly one ASCII letter (optionally
 * preceded by `/mnt/`) to be treated as a drive letter. This prevents
 * `/home/...` and `/usr/...` from being misinterpreted as drives.
 */
export function normalizePathInputForPlatform(input: string, platform: string): string {
	if (platform !== "win32") return input;
	// Git-Bash style: /<drive>/<rest>
	const gitBash = /^\/([a-zA-Z])\/(.*)$/.exec(input);
	if (gitBash) {
		const drive = gitBash[1]!.toUpperCase();
		const rest = gitBash[2]!.replace(/\//g, "\\");
		return `${drive}:\\${rest}`;
	}
	// WSL style: /mnt/<drive>/<rest>
	const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(input);
	if (wsl) {
		const drive = wsl[1]!.toUpperCase();
		const rest = wsl[2]!.replace(/\//g, "\\");
		return `${drive}:\\${rest}`;
	}
	return input;
}

export type FilePathError =
	| { kind: "traversal"; path: string; message: string }
	| { kind: "missing"; path: string; suggestion?: string }
	| { kind: "ok"; path: string };

/**
 * Containment check, platform-agnostic (works on Windows backslash paths
 * as well as POSIX forward slashes). Mirrors the existing helper in
 * `tools/_factory.ts:isPathInRoot` -- kept in sync intentionally so the
 * two code paths agree on what "in root" means.
 */
export function isPathInRoot(target: string, root: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Project-root check with symlink-resolution. Returns false for paths
 * outside the root AND for paths that don't resolve on disk (ENOENT).
 *
 * Use `classifyFilePath` when the caller needs to tell those two cases
 * apart -- this lower-level helper is only exposed for tests.
 *
 * Two-stage check:
 *   1. Resolve via `resolve()` (no I/O) and verify containment. This
 *      catches absolute paths like `/etc/shadow` that are obviously
 *      outside the project root, regardless of whether they exist on
 *      disk or are readable.
 *   2. Then `realpathSync` to defeat symlink escapes (e.g. a symlink
 *      inside the project that points outside). Only run this when the
 *      first check passes, to avoid spurious false negatives on paths
 *      that are already provably outside the root.
 */
export function validatePathInProjectCore(rawPath: string, projectRoot: string = getEffectiveRoot()): boolean {
	const resolved = resolve(projectRoot, rawPath);
	const rootResolved = resolve(projectRoot);
	if (!isPathInRoot(resolved, rootResolved)) return false;
	try {
		const realResolved = realpathSync(resolved);
		const realRoot = realpathSync(rootResolved);
		return isPathInRoot(realResolved, realRoot);
	} catch (err) {
		// ENOENT means the path does not exist on disk -- the expected
		// outcome of a negative probe. Return false silently so callers
		// can produce a clean "not in project / not found" result; a
		// stderr line on every miss is user-visible noise (issue #632
		// UX principle: status/observation notes belong in the LLM
		// context, not stderr). Other errors (EACCES, ELOOP, ENOTDIR)
		// signal real filesystem issues worth surfacing.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		// realpathSync failures (EACCES, symlink loops, ...) mean
		// "we can't prove this path is in the project". Log to surface
		// unexpected cases (symlink loops, permission issues) but treat
		// as not-in-root so callers fall back to the safe path.
		console.warn(`[pi-shazam] validatePathInProjectCore: realpathSync failed for ${resolved}:`, err);
		return false;
	}
}

/**
 * Classify a project-relative path into one of three outcomes:
 *
 * - `"traversal"` -- escapes the project root. `message` is the canonical
 *   error string; safe to surface verbatim.
 * - `"missing"`   -- inside the root but the file is not on disk.
 *   `suggestion` (when computable) is the closest known file path.
 * - `"ok"`        -- the path resolves to a real file in the project.
 *
 * Two-stage decision so the caller can act differently on each class:
 *   1. Pure containment check via `resolve + isPathInRoot`. If the
 *      resolved path is provably outside the root (e.g. `/etc/shadow`
 *      or `../../foo`), classify as traversal -- regardless of whether
 *      the file exists. This avoids misclassifying legitimate traversal
 *      attempts as "missing" when the file happens to exist on disk.
 *   2. If containment passes but the file is not on disk, classify as
 *      missing. The symlink/realpath check in `validatePathInProjectCore`
 *      still gates the final `"ok"` outcome.
 */
export function classifyFilePath(relPath: string, projectRoot: string): FilePathError {
	// #673: normalize Git-Bash /c/foo and WSL /mnt/c/foo to C:\foo on Windows.
	relPath = normalizePathInput(relPath);
	// Use `resolve` (not `join`) so absolute paths like `/etc/shadow`
	// short-circuit to themselves rather than being appended to the root.
	const absPath = resolve(projectRoot, relPath);
	const rootResolved = resolve(projectRoot);
	if (!isPathInRoot(absPath, rootResolved)) {
		return {
			kind: "traversal",
			path: relPath,
			message: `File path '${relPath}' is outside the project root and cannot be accessed.`,
		};
	}
	if (!validatePathInProjectCore(relPath, projectRoot)) {
		// Path is inside the root by containment but failed the symlink/
		// existence check (ENOENT, EACCES, or a symlink that escapes).
		// Distinguish by probing existence directly: if the file is
		// genuinely missing on disk, the user probably mistyped.
		if (!existsSync(absPath)) {
			return { kind: "missing", path: relPath };
		}
		// Path exists but realpathSync told us it's not in the root --
		// most likely a symlink that escapes. Treat as traversal.
		return {
			kind: "traversal",
			path: relPath,
			message: `File path '${relPath}' is outside the project root and cannot be accessed.`,
		};
	}
	return { kind: "ok", path: relPath };
}

/**
 * Find the closest known file to `query` using bounded Levenshtein distance.
 *
 * Returns the first candidate with distance `<= maxDistance` (default 3),
 * ordered by ascending distance. Ties broken lexicographically for
 * determinism. Pure function -- depends only on the `knownFiles` iterable.
 *
 * `knownFiles` typically comes from `graph.fileSymbols.keys()`.
 */
export function suggestSimilarFile(query: string, knownFiles: Iterable<string>, maxDistance = 3): string | undefined {
	let best: { path: string; distance: number } | undefined;
	for (const candidate of knownFiles) {
		const distance = levenshtein(query, candidate, maxDistance);
		if (distance > maxDistance) continue;
		if (best === undefined || distance < best.distance) {
			best = { path: candidate, distance };
			continue;
		}
		if (distance === best.distance && candidate.localeCompare(best.path) < 0) {
			best = { path: candidate, distance };
		}
	}
	return best?.path;
}

/**
 * Levenshtein distance with an early-exit when the running minimum
 * drops below `cutoff`. Returns `cutoff + 1` when the true distance
 * would exceed the cutoff, letting callers skip candidates cheaply.
 *
 * Standard dynamic-programming algorithm; O(m * n) time and space.
 * For the typical input sizes here (paths under ~200 chars, cutoff 3)
 * this is plenty fast and avoids a third-party dependency.
 */
export function levenshtein(a: string, b: string, cutoff: number = Infinity): number {
	if (a === b) return 0;
	const m = a.length;
	const n = b.length;
	if (Math.abs(m - n) > cutoff) return cutoff + 1;
	if (m === 0) return n;
	if (n === 0) return m;

	// Two-row rolling buffer to keep memory at O(min(m, n)).
	let prev = new Array<number>(n + 1);
	let curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;

	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= n; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		// Early exit when every cell in this row already exceeds the cutoff.
		if (rowMin > cutoff) return cutoff + 1;
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

/**
 * Return the current user's home directory, falling back across
 * platforms. On Windows HOME is often unset, so USERPROFILE is the
 * canonical source (issue #586). If neither is set, returns whatever
 * `os.homedir()` reports (Node already handles the platform default).
 *
 * `os.homedir()` already returns a realpath-resolved path on macOS
 * managed profiles (`/Users/foo`, not `/home/foo -> /Users/foo`), so
 * no further fs resolution is needed. This keeps the helper pure
 * (no `realpathSync`) which is important for testability: callers
 * that mock `node:fs.realpathSync` for other reasons do not
 * accidentally distort the home directory.
 */
export function getHomeDirectory(): string {
	const fromEnv = process.env.HOME || process.env.USERPROFILE;
	if (fromEnv && fromEnv.length > 0) {
		// Pass POSIX-style paths through verbatim. `node:path.resolve`
		// on Windows rewrites `/foo` to `C:\foo`, which would translate a
		// CI-style HOME (e.g. `/home/runner`) into a Windows path and
		// break the containment check below when the candidate is also
		// POSIX-style. The downstream `isHomeDirectory` handles
		// POSIX-style paths uniformly across platforms.
		const looksPosixStyle = fromEnv.startsWith("/") && !fromEnv.startsWith("//");
		if (looksPosixStyle) {
			return fromEnv;
		}
		return resolve(fromEnv);
	}
	return homedir();
}

/**
 * Platform-parameterized core of `isHomeDirectory`. Exposed so tests
 * can exercise the win32 branch on POSIX runners (mirrors the
 * `normalizePathInputForPlatform` pattern). See `isHomeDirectory`
 * for the public contract.
 */
export function isHomeDirectoryForPlatform(
	root: string,
	platform: NodeJS.Platform,
	homeDir: string = getHomeDirectory(),
): boolean {
	if (!root) return false;
	// Detect POSIX-style paths up front: `node:path.resolve` on Windows
	// rewrites `/foo` to `C:\foo`, which breaks containment checks when
	// the home directory is also POSIX-style (common on CI runners where
	// HOME is set to `/home/runner/...` rather than translated to a
	// Windows path). Pass POSIX-style inputs through verbatim regardless
	// of platform so the comparison below is consistent.
	const looksPosixStyle = root.startsWith("/") && !root.startsWith("//");
	const looksWin32Absolute = /^[A-Za-z]:[\\/]/.test(root);
	const candidateResolved = looksWin32Absolute || looksPosixStyle ? root : resolve(root);

	// On win32 with POSIX-style paths (e.g. CI runners that set HOME to
	// /home/me without translating to Windows format), use POSIX
	// comparison logic -- the candidate is also POSIX-style so we should
	// not force a backslash separator that does not appear in either
	// side. The case-insensitive win32 branch only applies when both
	// sides use Windows separators.
	const homeIsWin32Style = homeDir.includes("\\");
	if (platform === "win32" && homeIsWin32Style && !looksPosixStyle) {
		// Case-insensitive containment on Windows (issue #668).
		const lowerHome = homeDir.toLowerCase();
		const lowerCandidate = candidateResolved.toLowerCase();
		if (lowerCandidate === lowerHome) return true;
		// Treat both separators uniformly for the prefix check.
		const homeWithSep = lowerHome.endsWith("\\") ? lowerHome : lowerHome + "\\";
		return lowerCandidate.startsWith(homeWithSep);
	}

	if (candidateResolved === homeDir) return true;
	// When either side is POSIX-style, force a POSIX separator so the
	// prefix check uses the same separator the candidate uses. On Windows
	// the default `path.sep` is "\\" but a POSIX-style candidate never
	// contains it.
	const usePosixSep = looksPosixStyle || !homeIsWin32Style;
	const sep = usePosixSep ? "/" : pathSep;
	const homeWithSep = homeDir.endsWith(sep) || homeDir.endsWith(pathSep) ? homeDir : homeDir + sep;
	return candidateResolved.startsWith(homeWithSep);
}

/**
 * Check whether `root` is the user's home directory or a direct child
 * of it. Returns false for unrelated paths and for paths that merely
 * share a prefix with the home directory (e.g. /home/melody vs
 * /home/me).
 *
 * Cross-platform:
 *  - POSIX: case-sensitive, separator = "/".
 *  - Windows: case-insensitive on the drive and path components,
 *    separator = "\\" after resolution.
 *
 * Issue #720: this helper powers the default home-refusal guard in
 * the MCP entry and the native entry. Set PI_SHAZAM_ALLOW_HOME=1 to
 * opt out of the guard.
 */
export function isHomeDirectory(root: string): boolean {
	return isHomeDirectoryForPlatform(root, process.platform);
}

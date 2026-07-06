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
import { relative, resolve, isAbsolute } from "node:path";

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
export function validatePathInProjectCore(rawPath: string, projectRoot: string = process.cwd()): boolean {
	const resolved = resolve(projectRoot, rawPath);
	const rootResolved = resolve(projectRoot);
	if (!isPathInRoot(resolved, rootResolved)) return false;
	try {
		const realResolved = realpathSync(resolved);
		const realRoot = realpathSync(rootResolved);
		return isPathInRoot(realResolved, realRoot);
	} catch (err) {
		// realpathSync failures (ENOENT, EACCES, symlink loops) all mean
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

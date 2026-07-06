/**
 * Single source of truth for "is this a test file?" detection.
 *
 * Used by `shazam_impact` in both `--files` and `--symbol` modes to surface
 * the "Affected Tests (must re-run)" section. Centralizing the patterns here
 * eliminates the inconsistency tracked in issue #635 where `--symbol` mode
 * silently omitted test files.
 *
 * The four patterns cover the common JS/TS test layouts:
 *   - `.test.` / `.spec.`  (Vitest, Jest, Mocha, Jasmine)
 *   - `__tests__/`         (Jest convention)
 *   - `tests/`             (Vitest default, pi-shazam itself)
 *
 * Pure function on a project-relative POSIX path. No filesystem access.
 */

// Ordered list of test-file predicates. Each receives a POSIX-style relative
// path (forward slashes, no leading `./`) and returns true if the path matches
// that pattern. Order is informational only; the predicates are OR-combined.
const TEST_PATTERNS: ReadonlyArray<(relPath: string) => boolean> = [
	(p) => p.includes(".test."),
	(p) => p.includes(".spec."),
	(p) => p.includes("__tests__"),
	(p) => p.startsWith("tests/"),
];

/**
 * Returns true if the given project-relative path looks like a test file.
 *
 * Backwards compatible with the inline check that previously lived at
 * `tools/impact.ts:209`; the four patterns are unchanged.
 */
export function isTestFile(relPath: string): boolean {
	for (const matches of TEST_PATTERNS) {
		if (matches(relPath)) return true;
	}
	return false;
}

/**
 * Partitions a list of relative paths into test files and non-test files,
 * preserving input order within each bucket.
 */
export function filterTestFiles(relPaths: string[]): { tests: string[]; nonTests: string[] } {
	const tests: string[] = [];
	const nonTests: string[] = [];
	for (const p of relPaths) {
		if (isTestFile(p)) tests.push(p);
		else nonTests.push(p);
	}
	return { tests, nonTests };
}

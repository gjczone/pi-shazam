/**
 * pi-shazam core/filter — Shared file filtering utilities.
 *
 * Centralises the "is this a source file?" logic used by hotspots, orphan,
 * verify, overview, and check tools. Keeps filtering consistent across the
 * codebase and avoids pattern duplication.
 */

/**
 * Config files, generated files, and lockfiles — excluded from source-file
 * analysis (hotspots, orphan detection, overview, check).
 *
 * The list is deliberately narrow: it covers *non-source* files that
 * tree-sitter would still parse (JSON, lockfiles) and inflate symbol counts.
 *
 * @returns true if the file path matches a known non-source pattern.
 */
const NON_SOURCE_FILE_PATTERNS: readonly string[] = [
	"package-lock.json",
	"package.json",
	"tsconfig.json",
	"node_modules/",
	"dist/",
	".json",
];

export function isNonSourceFile(file: string): boolean {
	return NON_SOURCE_FILE_PATTERNS.some((p) => file.includes(p));
}

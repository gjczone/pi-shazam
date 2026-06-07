/**
 * pi-shazam core/filter — Shared file filtering utilities.
 *
 * Centralises the "is this a source file?" logic used by hotspots, orphan,
 * verify, overview, and check tools. Keeps filtering consistent across the
 * codebase and avoids pattern duplication.
 */

import type { RepoGraph } from "./graph.js";

/**
 * Config files, generated files, and lockfiles — excluded from source-file
 * analysis (hotspots, orphan detection, overview, check).
 *
 * The list is deliberately narrow: it covers *non-source* files that
 * tree-sitter would still parse (JSON, lockfiles) and inflate symbol counts.
 *
 * @returns true if the file path matches a known non-source pattern.
 */
const NON_SOURCE_FILE_PATTERNS: readonly RegExp[] = [
	/package-lock\.json$/,
	/^package\.json$/,
	/(?:^|\/)tsconfig[^/]*\.json$/,
	/node_modules\//,
	/\/dist\//,
	/\.json$/,
];

/**
 * Directories to skip during project scanning and LSP detection.
 *
 * Single source of truth -- consumed by core/scanner.ts and lsp/manager.ts.
 * Includes build outputs, dependency caches, virtual environments, IDE
 * directories, and other non-source trees that should never be walked.
 */
export const SKIP_DIRS = new Set([
	"node_modules",
	"bower_components",
	"vendor",
	"dist",
	"build",
	"out",
	"target",
	".git",
	".cache",
	".worktrees",
	".pi-shazam",
	".qoder",
	"__pycache__",
	"coverage",
	".nyc_output",
	"tmp",
	"temp",
	".venv",
	"venv",
	".tox",
	".next",
	".nuxt",
	".turbo",
	".vercel",
	".yarn",
	".idea",
	".vscode",
]);

export function isNonSourceFile(file: string): boolean {
	return NON_SOURCE_FILE_PATTERNS.some((p) => p.test(file));
}

/**
 * Check if a file path is in an MCP/tools registration directory.
 * These files export functions that are called dynamically by frameworks.
 */
function isRegistrationFile(file: string): boolean {
	return (
		file.includes("/mcp/") ||
		file.includes("/hooks/") ||
		file.endsWith("_factory.ts") ||
		file.endsWith("_factory.js") ||
		file.endsWith("index.ts") ||
		file.endsWith("index.js")
	);
}

/**
 * Check if a symbol name matches a registration pattern.
 * Registration functions are typically called dynamically by frameworks.
 */
function isRegistrationSymbol(name: string): boolean {
	return (
		name.startsWith("register") ||
		name.startsWith("createTool") ||
		name === "execute" ||
		name === "handler"
	);
}

/**
 * Shared orphan symbol detection.
 *
 * Single implementation used by baseline diff and verify tools.
 * Uses isNonSourceFile() for consistent filtering (avoids false matches
 * from naive includes("node_modules")).
 *
 * Returns symbols with zero incoming references, excluding:
 *  - Non-source files (config, lockfiles, node_modules, dist)
 *  - High-PageRank exported symbols (likely public API)
 *  - Anonymous functions (no name to reference)
 *  - Test files
 *  - Registration functions (register*, createTool) called by MCP/extension frameworks
 *  - Exported symbols in registration/entry-point files (called externally)
 */
export function findOrphans(graph: RepoGraph): { name: string; kind: string; file: string; line: number }[] {
	const orphans: { name: string; kind: string; file: string; line: number }[] = [];
	for (const sym of graph.symbols.values()) {
		if (isNonSourceFile(sym.file)) continue;
		const incoming = graph.incoming.get(sym.id);
		if (!incoming || incoming.length === 0) {
			// Skip high-PageRank exported symbols (public API)
			if (sym.visibility === "exported" && sym.pagerank > 0.01) continue;
			// Skip anonymous functions
			if (sym.kind === "anonymous_function") continue;
			// Skip test files
			if (sym.file.includes("tests/") || sym.file.includes(".test.")) continue;
			// Skip registration functions called dynamically by frameworks
			if (isRegistrationSymbol(sym.name)) continue;
			// Skip exported symbols in registration/entry-point files
			if (sym.visibility === "exported" && isRegistrationFile(sym.file)) continue;
			orphans.push({ name: sym.name, kind: sym.kind, file: sym.file, line: sym.line });
		}
	}
	return orphans;
}

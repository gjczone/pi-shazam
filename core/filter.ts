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

function isEntryPointSymbol(name: string, kind: string): boolean {
	// Python entry points
	if (
		name === "__init__" ||
		name === "__str__" ||
		name === "__repr__" ||
		name === "__len__" ||
		name === "__iter__" ||
		name === "__getitem__" ||
		name === "__setitem__" ||
		name === "__call__" ||
		name === "__enter__" ||
		name === "__exit__" ||
		name === "__aenter__" ||
		name === "__aexit__" ||
		name === "__anext__" ||
		name === "__aiter__" ||
		name === "__main__"
	) {
		return true;
	}
	// Rust entry points
	if (name === "main" && kind === "function") return true;
	if (name === "Default" && kind === "trait") return true;
	if (name === "Drop" && kind === "trait") return true;
	// Go entry points
	if (name === "main" && kind === "function") return true;
	if (name === "init" && kind === "function") return true;
	// Common framework entry points
	if (name.startsWith("test_") || name.startsWith("Test")) return true;
	return false;
}

function isFrameworkHandler(name: string): boolean {
	// Flask/FastAPI/Django route handlers and middleware
	if (name.startsWith("test_") || name.startsWith("Test")) return true;
	if (name.startsWith("handle_") || name.startsWith("on_")) return true;
	if (name.startsWith("middleware")) return true;
	if (name.endsWith("_handler") || name.endsWith("Handler")) return true;
	return false;
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
 *  - Language-specific entry point symbols (dunder methods, main, traits)
 *  - Framework handler patterns (handle_*, on_*, middleware, *_handler)
 *
 * Returns structured result with separate lists for internal and exported orphans.
 */
export function findOrphans(graph: RepoGraph): {
	all: { name: string; kind: string; file: string; line: number; isExported: boolean }[];
	internal: { name: string; kind: string; file: string; line: number }[];
	exported: { name: string; kind: string; file: string; line: number }[];
} {
	const all: { name: string; kind: string; file: string; line: number; isExported: boolean }[] = [];
	const internal: { name: string; kind: string; file: string; line: number }[] = [];
	const exported: { name: string; kind: string; file: string; line: number }[] = [];

	for (const sym of graph.symbols.values()) {
		if (isNonSourceFile(sym.file)) continue;
		const incoming = graph.incoming.get(sym.id);
		if (!incoming || incoming.length === 0) {
			// Skip high-PageRank exported symbols (public API)
			if (sym.visibility === "exported" && sym.pagerank > 0.01) continue;
			// Skip anonymous functions
			if (sym.kind === "anonymous_function") continue;
			// Skip test files
			if (sym.file.includes("tests/") || sym.file.includes(".test.") || sym.file.includes("test_") || sym.file.includes("_test.") || sym.file.includes("/test/")) continue;
			// Skip registration functions called dynamically by frameworks
			if (isRegistrationSymbol(sym.name)) continue;
			// Skip language-specific entry point symbols
			if (isEntryPointSymbol(sym.name, sym.kind)) continue;
			// Skip framework handler patterns
			if (isFrameworkHandler(sym.name)) continue;
			// Skip exported symbols in registration/entry-point files
			if (sym.visibility === "exported" && isRegistrationFile(sym.file)) continue;

			const isExported = sym.visibility === "exported";
			const orphan = { name: sym.name, kind: sym.kind, file: sym.file, line: sym.line };
			all.push({ ...orphan, isExported });
			if (isExported) {
				exported.push(orphan);
			} else {
				internal.push(orphan);
			}
		}
	}

	return { all, internal, exported };
}

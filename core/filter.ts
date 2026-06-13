/**
 * pi-shazam core/filter — Shared file filtering utilities.
 *
 * Centralises the "is this a source file?" logic used by hotspots, orphan,
 * verify, overview, and check tools. Keeps filtering consistent across the
 * codebase and avoids pattern duplication.
 */

import type { RepoGraph } from "./graph.js";
import { dirname, join } from "node:path";

/**
 * Resolve an import specifier to a normalized file path, mirroring
 * core/scanner.ts resolveImport. Used to match raw import specifiers
 * (e.g. "./utils") against symbol file paths (e.g. "src/utils.ts").
 *
 * Tries common TypeScript/JavaScript extensions when the specifier
 * does not include one.
 */
function resolveModulePath(importPath: string, fromFile: string): string {
	if (!importPath.startsWith(".")) return importPath;
	const fromDir = dirname(fromFile);
	let resolved = join(fromDir, importPath);
	resolved = resolved.replace(/\\/g, "/");
	// Normalize leading "./" for consistency with RepoGraph symbol files
	if (resolved.startsWith("./")) resolved = resolved.slice(2);
	return resolved;
}

/**
 * Check if a resolved module path matches a target symbol file.
 * Supports matches with or without file extensions.
 */
function moduleMatchesFile(resolvedModule: string, targetFile: string): boolean {
	if (resolvedModule === targetFile) return true;
	const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];
	for (const ext of EXTENSIONS) {
		if (resolvedModule + ext === targetFile) return true;
	}
	// Handle /index.* default imports
	for (const ext of EXTENSIONS) {
		if (resolvedModule + "/index" + ext === targetFile) return true;
	}
	return false;
}

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
	/node_modules(?:\/|$)/,
	/(?:^|\/)dist(?:\/|$)/,
	/(?:^|\/)build(?:\/|$)/,
	/(?:^|\/)out(?:\/|$)/,
	/(?:^|\/)target(?:\/|$)/,
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
 * Check whether a normalized absolute path should be tracked by the
 * pre-edit guard. Returns false for paths inside non-source trees
 * (SKIP_DIRS, dot-directories not in SKIP_DIRS, node_modules, dist, etc.).
 *
 * Single source of truth mirroring scanner.ts's directory filtering so
 * pre-edit.ts does not flag writes to /tmp/, ~/.pi/, or build outputs
 * as "unverified edits".
 */
export function isTrackableEditedPath(normalizedPath: string): boolean {
	// Fast path: reject non-source files by pattern (node_modules, dist, *.json)
	if (isNonSourceFile(normalizedPath)) return false;

	// Segment-based check: reject any path that traverses a skipped directory
	// or a dot-directory not in SKIP_DIRS (e.g. .pi, .git, .cache)
	const segments = normalizedPath.split("/").filter(Boolean);
	for (const seg of segments) {
		if (SKIP_DIRS.has(seg)) return false;
		if (seg.startsWith(".") && !SKIP_DIRS.has(seg)) return false;
	}

	return true;
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
 *  - ALL exported symbols (consumers are external to the scanned graph)
 *  - .d.ts ambient declaration files (issue #244 — ambient types are consumed
 *    via global scope or type-only imports invisible to symbol-level refs)
 *  - Files imported purely for side effects (no named/namespace binding from
 *    any importer — issue #243). Files with bindings retain full detection
 *    so unused internals in namespace-imported modules still surface (#246).
 *  - PascalCase functions/classes in .tsx/.jsx files (React components
 *    consumed via JSX, which does not create a symbol-level ref — #249)
 *  - Anonymous functions (no name to reference)
 *  - Test files
 *  - Registration functions (register*, createTool) called by MCP/extension frameworks
 *  - Language-specific entry point symbols (dunder methods, main, traits)
 *  - Framework handler patterns (handle_*, on_*, middleware, *_handler)
 *
 * Returns structured result with separate lists for internal and exported orphans.
 * The exported list is always empty under the current policy (all exports excluded).
 */
export function findOrphans(graph: RepoGraph): {
	all: { name: string; kind: string; file: string; line: number; isExported: boolean }[];
	internal: { name: string; kind: string; file: string; line: number }[];
	exported: { name: string; kind: string; file: string; line: number }[];
} {
	const all: { name: string; kind: string; file: string; line: number; isExported: boolean }[] = [];
	const internal: { name: string; kind: string; file: string; line: number }[] = [];
	const exported: { name: string; kind: string; file: string; line: number }[] = [];

	// Pre-compute the set of files that are imported purely for side effects
	// (i.e. appear in fileImports but the importer has NO import binding
	// resolving to that file). Side-effect imports (`import './polyfill'`)
	// create file-level edges but no symbol-level bindings, so their
	// symbols would otherwise be reported as orphans.
	//
	// Files imported via named/namespace imports are NOT in this set —
	// they have bindings and their unused internal symbols should still be
	// reported (issue #246).
	const sideEffectOnlyFiles = new Set<string>();
	for (const [importer, targets] of graph.fileImports) {
		const bindings = graph.fileImportBindings.get(importer) ?? [];
		for (const target of targets) {
			const hasBinding = bindings.some((b) => {
				const resolved = resolveModulePath(b.module, importer);
				return moduleMatchesFile(resolved, target);
			});
			if (!hasBinding) sideEffectOnlyFiles.add(target);
		}
	}

	for (const sym of graph.symbols.values()) {
		if (isNonSourceFile(sym.file)) continue;
		// Skip .d.ts ambient declaration files — by design, their symbols
		// are consumed via global scope or type-only imports, neither of
		// which produces a symbol-level reference in the graph (issue #244).
		if (sym.file.endsWith(".d.ts")) continue;
		// Skip ALL exported symbols — external consumers are invisible to
		// tree-sitter scan, so zero internal refs does not mean dead code.
		if (sym.visibility === "exported") continue;
		// Skip symbols in side-effect-only imported modules (issue #243).
		if (sideEffectOnlyFiles.has(sym.file)) continue;
		// Skip PascalCase functions/classes in .tsx/.jsx files — they are
		// almost certainly React components consumed via `<Component />`
		// JSX syntax, which does not create a symbol-level reference
		// in the graph (issue #249).
		if (
			(sym.file.endsWith(".tsx") || sym.file.endsWith(".jsx")) &&
			(sym.kind === "function" || sym.kind === "class") &&
			/^[A-Z]/.test(sym.name)
		) {
			continue;
		}
		const incoming = graph.incoming.get(sym.id);
		if (!incoming || incoming.length === 0) {
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

			const orphan = { name: sym.name, kind: sym.kind, file: sym.file, line: sym.line };
			all.push({ ...orphan, isExported: false });
			internal.push(orphan);
		}
	}

	return { all, internal, exported };
}

/**
 * pi-shazam core/filter -- Shared file filtering utilities.
 *
 * Centralises the "is this a source file?" logic used by hotspots, orphan,
 * verify, overview, and check tools. Keeps filtering consistent across the
 * codebase and avoids pattern duplication.
 */

import type { RepoGraph } from "./graph.js";
import { resolveModulePath, moduleMatchesFile } from "./resolve-import.js";

/**
 * Config files, generated files, and lockfiles -- excluded from source-file
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
	/(?:^|\/)vendor(?:\/|$)/, // vendor directories
	/\.min\.(?:js|css|mjs|cjs)$/, // minified files
	/\.generated\./, // generated files
	/\.bundle\.(?:js|css|mjs)$/, // bundle artifacts
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
	".pi",
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
	// Issue #720: cross-platform non-source trees commonly found under $HOME.
	// Walking these on home-directory scans is the bulk of the wasted work.
	"snap", // Ubuntu snap package tree
	"Library", // macOS
	"Applications", // macOS
	"Movies",
	"Music",
	"Pictures",
	"Application Data", // Windows shell folder
	"Desktop",
	"Downloads",
	"Documents",
]);

export function isNonSourceFile(file: string): boolean {
	// Normalize Windows backslash separators to "/" so the POSIX-anchored
	// patterns above match graph keys that use backslashes (#663). Mirrors
	// the normalization already done in isTestFile.
	const normalized = file.replace(/\\/g, "/");
	return NON_SOURCE_FILE_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Test file patterns -- matches common test file naming conventions
 * across languages (TS/JS, Python, Go, Rust, etc.).
 *
 * Single source of truth for test file detection. Superset of the
 * patterns previously scattered across output.ts, verify.ts, and
 * filter.ts findOrphans.
 */
const TEST_FILE_PATTERNS: readonly RegExp[] = [
	// JS/TS test file extensions
	/\.(test|spec|e2e)\.(ts|js|tsx|jsx|mts|mjs|cjs|cts)$/,
	// Python test files
	/(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py)$/,
	// Go test files
	/(?:^|\/)[^/]+_test\.go$/,
	// Rust test files
	/(?:^|\/)(?:test_[^/]+\.rs|[^/]+_test\.rs)$/,
	// Generic test directory patterns (tests/, test/, __tests__/)
	/(?:^|[/.])tests?\//,
	/(?:^|[/.])__tests?\//,
	// Generic .test.* and .spec.* (language-agnostic, covers .test.py, .test.go, etc.)
	/\.test\.[a-z]+$/,
	/\.spec\.[a-z]+$/,
	// Generic test_ prefix (language-agnostic)
	/(?:^|[/.])test_[a-z_]+\.[a-z]+$/,
	// Generic _test suffix (language-agnostic)
	/_test\.[a-z]+$/,
];

/**
 * Directories that indicate a test context.
 */
const TEST_DIRS = new Set(["__tests__", "__test__", "test", "tests", "spec"]);

/**
 * Check whether a file path belongs to a test file.
 *
 * Uses both pattern matching on the file path and directory name
 * checks. Covers JS/TS (.test.ts, .spec.tsx), Python (test_*.py,
 * *_test.py), Go (*_test.go), Rust (test_*.rs, *_test.rs), and
 * generic patterns (tests/ dir, __tests__/ dir).
 *
 * Single source of truth -- consumed by core/output.ts,
 * tools/verify.ts, and core/filter.ts findOrphans.
 */
export function isTestFile(filePath: string): boolean {
	if (TEST_FILE_PATTERNS.some((p) => p.test(filePath))) return true;
	const parts = filePath.replace(/\\/g, "/").split("/");
	return parts.some((p) => TEST_DIRS.has(p));
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
/**
 * Dot-prefixed directory names that contain legitimate config files
 * which should be trackable by the pre-edit guard.
 */
const DOT_PREFIX_ALLOWLIST = new Set([".github", ".husky", ".vscode", ".claude"]);

export function isTrackableEditedPath(normalizedPath: string): boolean {
	// Fast path: reject non-source files by pattern (node_modules, dist, *.json)
	if (isNonSourceFile(normalizedPath)) return false;

	// Segment-based check: reject any path that traverses a skipped directory
	// or a dot-directory not in SKIP_DIRS (e.g. .pi, .git, .cache)
	const segments = normalizedPath.split(/[\\/]+/).filter(Boolean);
	for (const seg of segments) {
		if (SKIP_DIRS.has(seg)) return false;
		if (seg.startsWith(".") && !SKIP_DIRS.has(seg) && !DOT_PREFIX_ALLOWLIST.has(seg)) return false;
	}

	return true;
}

/**
 * Check if a symbol name matches a registration pattern.
 * Registration functions are typically called dynamically by frameworks.
 */
function isRegistrationSymbol(name: string): boolean {
	return name.startsWith("register") || name.startsWith("createTool") || name === "execute" || name === "handler";
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
	// Rust standard trait implementations -- these are dispatched by the
	// compiler or standard library, never called by name in user code.
	// Without this, every `impl Clone for Foo` etc. is a false orphan.
	if (kind === "impl" || kind === "trait") {
		const RUST_STD_TRAITS = new Set([
			"From",
			"Into",
			"TryFrom",
			"TryInto",
			"Display",
			"Debug",
			"Clone",
			"Copy",
			"Hash",
			"Eq",
			"PartialEq",
			"Ord",
			"PartialOrd",
			"Serialize",
			"Deserialize",
			"Iterator",
			"IntoIterator",
			"FromStr",
			"AsRef",
			"AsMut",
			"Deref",
			"DerefMut",
			"Fn",
			"FnMut",
			"FnOnce",
			"Send",
			"Sync",
			"Error",
			"Default",
			"Drop",
		]);
		if (RUST_STD_TRAITS.has(name)) return true;
	}
	// Go entry points
	if (name === "main" && kind === "function") return true;
	if (name === "init" && kind === "function") return true;
	// Rust module declarations are structural -- they namespace items but
	// are never referenced by name at runtime.
	if (kind === "module") return true;
	// Common framework entry points
	if (name.startsWith("test_") || name.startsWith("Test")) return true;
	return false;
}

function isFrameworkHandler(name: string, file?: string, kind?: string): boolean {
	// Flask/FastAPI/Django route handlers and middleware
	if (name.startsWith("test_") || name.startsWith("Test")) return true;
	if (name.startsWith("handle_") || name.startsWith("on_")) return true;
	if (name.startsWith("middleware")) return true;
	if (name.endsWith("_handler") || name.endsWith("Handler")) return true;
	// Rust framework entry points (axum, actix, tower, tonic, etc.)
	// These are called by framework dispatch, not by name in user code.
	if (file?.endsWith(".rs") && kind === "function") {
		const RUST_FRAMEWORK_FNS = new Set([
			"new",
			"run",
			"serve",
			"from_request",
			"into_response",
			"call",
			"poll_ready",
			"handle",
			"next",
		]);
		if (RUST_FRAMEWORK_FNS.has(name)) return true;
	}
	return false;
}

/**
 * Infrastructure symbols that are live code at module top level but invisible
 * to the dependency graph because their usage is in top-level expressions
 * (tree-sitter does not create symbol-level edges for top-level calls).
 *
 * These are NEVER dead code — they are module infrastructure. Skipping them
 * prevents false-positive orphan reports in verify output.
 */
function isInfrastructureWrapper(name: string, kind: string, _file?: string): boolean {
	// Node.js ESM/CJS interop: const _require = createRequire(import.meta.url)
	if (kind === "function" && name === "_require") return true;

	// ESM __filename / __dirname equivalents: fileURLToPath(import.meta.url)
	if ((kind === "variable" || kind === "const") && (name === "__filename" || name === "__dirname")) return true;

	return false;
}

/**
 * Check if a symbol is referenced within its own file via fileCalls or fileRefs.
 *
 * When a call/reference occurs at the top level of a module (not inside any
 * function/class body), findCallerSymbols returns empty because no symbol's
 * range covers that line. This causes the same-file call to produce no edge,
 * leaving the callee with zero incoming references -- a false positive orphan
 * (issue #444).
 *
 * This function provides a fallback check: if the symbol's name appears in
 * its own file's call or ref lists, it is genuinely referenced within that
 * file and should not be classified as orphan.
 */
function _hasSameFileRef(graph: RepoGraph, sym: { name: string; file: string }): boolean {
	const calls = graph.fileCalls.get(sym.file);
	if (calls) {
		for (const [calleeName] of calls) {
			if (calleeName === sym.name) return true;
		}
	}
	const refs = graph.fileRefs.get(sym.file);
	if (refs) {
		for (const [refName] of refs) {
			if (refName === sym.name) return true;
		}
	}
	const typeRefs = graph.fileTypeRefs.get(sym.file);
	if (typeRefs) {
		for (const [typeName] of typeRefs) {
			if (typeName === sym.name) return true;
		}
	}
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
 *  - .d.ts ambient declaration files (issue #244 -- ambient types are consumed
 *    via global scope or type-only imports invisible to symbol-level refs)
 *  - Files imported purely for side effects (no named/namespace binding from
 *    any importer -- issue #243). Files with bindings retain full detection
 *    so unused internals in namespace-imported modules still surface (#246).
 *  - PascalCase functions/classes in .tsx/.jsx files (React components
 *    consumed via JSX, which does not create a symbol-level ref -- #249)
 *  - Anonymous functions (no name to reference)
 *  - Test files
 *  - Registration functions (register*, createTool) called by MCP/extension frameworks
 *  - Language-specific entry point symbols (dunder methods, main, traits)
 *  - Framework handler patterns (handle_*, on_*, middleware, *_handler)
 *  - Symbols referenced within their own file via fileCalls/fileRefs,
 *    even when no symbol-level edge exists (issue #444 -- top-level
 *    calls outside any function body produce no caller->callee edge)
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
	// Files imported via named/namespace imports are NOT in this set --
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
		// Skip .d.ts ambient declaration files -- by design, their symbols
		// are consumed via global scope or type-only imports, neither of
		// which produces a symbol-level reference in the graph (issue #244).
		if (sym.file.endsWith(".d.ts")) continue;
		// Skip ALL exported symbols -- external consumers are invisible to
		// tree-sitter scan, so zero internal refs does not mean dead code.
		if (sym.visibility === "exported") continue;
		// Skip symbols in side-effect-only imported modules (issue #243).
		if (sideEffectOnlyFiles.has(sym.file)) continue;
		// Skip PascalCase functions/classes in .tsx/.jsx files -- they are
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
		// Skip TypeScript interfaces and type aliases unconditionally.
		// These are structural type declarations consumed by the type system
		// (type annotations, extends, implements, generics). They may have
		// incoming import edges (from module-level imports) but never have
		// meaningful runtime callers, so they should never be flagged as
		// orphans regardless of incoming edge count (issue #262).
		if (sym.kind === "interface" || sym.kind === "type_alias") continue;
		const incoming = graph.incoming.get(sym.id);
		if (!incoming || incoming.length === 0) {
			// Same-file reference fallback (issue #444): top-level calls
			// outside any function body produce no symbol-level edge,
			// but the symbol is genuinely used within its own file.
			if (_hasSameFileRef(graph, sym)) continue;
			// Skip anonymous functions
			if (sym.kind === "anonymous_function") continue;
			// Skip impl blocks -- they are structural declarations (impl Foo { ... })
			// and are never referenced by name in the call graph (fixes #252).
			if (sym.kind === "impl") continue;
			// Skip test files
			if (isTestFile(sym.file)) continue;
			// Skip registration functions called dynamically by frameworks
			if (isRegistrationSymbol(sym.name)) continue;
			// Skip language-specific entry point symbols
			if (isEntryPointSymbol(sym.name, sym.kind)) continue;
			// Skip framework handler patterns
			if (isFrameworkHandler(sym.name, sym.file, sym.kind)) continue;
			if (isInfrastructureWrapper(sym.name, sym.kind, sym.file)) continue;

			const orphan = { name: sym.name, kind: sym.kind, file: sym.file, line: sym.line };
			all.push({ ...orphan, isExported: false });
			internal.push(orphan);
		}
	}

	return { all, internal, exported };
}

/**
 * pi-shazam core/scanner -- Project scanning + graph building.
 *
 * Walks project directories, parses source files with tree-sitter,
 * extracts symbols/imports/calls, and builds the full RepoGraph.
 *
 * This is the main entry point that all tools compose from.
 */

import { readdirSync, statSync, realpathSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { TreeSitterAdapter, EXT_TO_LANG, type Tree, type SyntaxNode } from "./treesitter.js";
import { createRepoGraph, createEdge } from "./graph.js";
import type { RepoGraph, Symbol, Edge } from "./graph.js";
import { calculatePageRank } from "./pagerank.js";
import { readFileAdaptive, FileTooLargeError } from "./encoding.js";
import { getProjectCacheDir, saveGraphCache, loadGraphCache } from "./cache.js";
import { SKIP_DIRS, isTestFile } from "./filter.js";
import { resolveImport, clearExistsCache } from "./resolve-import.js";
import { normalizePathInput } from "./path-utils.js";
import { _logWarn } from "./output.js";

// -- Constants ----------------------------------------------------------------

/** Maximum files to scan (safety limit) */
export const MAX_FILES = 20_000;

/**
 * Default wall-clock budget (ms) for `_walkDirectory`. When the
 * directory walk exceeds this budget, the result is flagged
 * `truncated: true` and further descent stops. Issue #720 bounds
 * worst-case scan latency on adversarial trees (deeply nested
 * package managers, broken symlinks, etc.).
 *
 * Override via `PI_SHAZAM_SCAN_DEADLINE_MS` (set to 0 to disable).
 */
export const SCAN_DEADLINE_DEFAULT_MS = 10_000;

function getScanDeadlineMs(): number {
	const raw = process.env.PI_SHAZAM_SCAN_DEADLINE_MS;
	if (raw === undefined || raw === "") return SCAN_DEADLINE_DEFAULT_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return SCAN_DEADLINE_DEFAULT_MS;
	return parsed;
}

/** File extensions to scan */
const SOURCE_EXTS = new Set(Object.keys(EXT_TO_LANG));

// -- In-memory cache ---------------------------------------------------------

let cachedGraph: RepoGraph | null = null;

let cachedProjectPath: string = "";

// Per-graph test-exclusion count, indexed by the RepoGraph reference (issue #632).
// Tying the count to the graph (via WeakMap) avoids leaking values across cache
// hits, different project roots, or test fixtures -- each graph carries its own
// count, and the entry is GC'd with the graph itself. REVIEW-RULES P1 #5 / #14.
const excludedTestCountByGraph: WeakMap<RepoGraph, number> = new WeakMap();

let _scannerAdapter: TreeSitterAdapter | null = null;

function getScannerAdapter(): TreeSitterAdapter {
	if (!_scannerAdapter) {
		_scannerAdapter = new TreeSitterAdapter(() => {});
	}
	return _scannerAdapter;
}

// C3: Module-level project root override. When Pi detects the project in a
// subdirectory (ctx.cwd != process.cwd()), index.ts calls setProjectRoot()
// so the scanner uses the same root as LSP, not process.cwd().
let _projectRootOverride: string | null = null;

/**
 * Override the project root used by scanProject(".") and getProjectGraph(".").
 * Called from index.ts when Pi's ctx.cwd differs from process.cwd().
 */
export function setProjectRoot(root: string): void {
	// #673: normalize Git-Bash /c/foo and WSL /mnt/c/foo to C:\foo on Windows.
	_projectRootOverride = resolve(normalizePathInput(root));
}

/**
 * Clear the project root override set via setProjectRoot().
 * After this call, getEffectiveRoot() falls back to process.cwd().
 * Used by tests to avoid leaking an override across test suites.
 */
export function resetProjectRoot(): void {
	_projectRootOverride = null;
}

/**
 * Get the effective project root, respecting any override set via setProjectRoot().
 * Returns the override if set, otherwise process.cwd().
 */
export function getEffectiveRoot(): string {
	return _projectRootOverride ?? process.cwd();
}

// -- Concurrency guard (issue #92) -------------------------------------------
// While Node.js is single-threaded and scanProject() is fully synchronous,
// this mutex prevents re-entrant calls (e.g., scanProject called from within
// a tool that itself was triggered by another scanProject invocation).
let _scanning = false;
function enterScan(): void {
	if (_scanning) throw new Error("Re-entrant scanProject detected - this is a bug");
	_scanning = true;
}
function exitScan(): void {
	_scanning = false;
}

interface FileCacheEntry {
	mtime: number;
	symbols: Symbol[];
	imports: [string, number][];
	calls: [string, number, string][];
	refs: [string, number][];
	typeRefs: [string, number][];
	jsImportBindings: import("./graph.js").JSImportBinding[];
}

let cachedFiles: Map<string, FileCacheEntry> = new Map();

/**
 * Reset all in-memory caches. Used in tests and when cache may be stale.
 *
 * #626: TreeSitterAdapter is intentionally preserved across resetCache() to
 * avoid rebuilding the underlying native C++ Parser/Language/Query objects.
 * V8 cannot promptly reclaim those native objects, so every resetCache()
 * that nulled the adapter caused a transient native-heap inflation of
 * 100-300MB per verify cycle in long-lived MCP mode. The adapter is
 * language-only (no per-file state), so reusing it across cache resets is
 * safe — only the per-file analysis results need to be cleared.
 */
export function resetCache(): void {
	cachedGraph = null;
	cachedProjectPath = "";
	cachedFiles = new Map();
	clearExistsCache();
	// Intentionally NOT resetting _scannerAdapter — see #626.
}

/**
 * Record the number of test files excluded for a given graph (issue #632).
 * Tied to the graph instance via WeakMap so the count is GC'd with the graph
 * and cannot leak across cache hits or different project roots.
 */
function recordExcludedTestCount(graph: RepoGraph, count: number): void {
	if (count > 0) excludedTestCountByGraph.set(graph, count);
}

/**
 * Return the number of test files excluded when this graph was built.
 * Returns 0 when the graph was built with `includeTests: true` or when
 * the graph came from cache and the count was never recorded (older caches).
 */
export function getExcludedTestCount(graph: RepoGraph): number {
	return excludedTestCountByGraph.get(graph) ?? 0;
}

/**
 * Get per-file modification times for all source files in the project.
 */
function getFileMtimes(root: string, files: string[]): Map<string, number> {
	const mtimes = new Map<string, number>();
	for (const relPath of files) {
		try {
			mtimes.set(relPath, statSync(join(root, relPath)).mtimeMs);
		} catch (err) {
			// Log but continue -- file may have been deleted between collection and stat.
			// Use errno code check instead of substring-matching the message (#461).
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			_logWarn("getFileMtimes", `failed to stat ${relPath}`, err);
		}
	}
	return mtimes;
}

/**
 * Options for `scanProject` that control graph construction policy.
 *
 * `includeTests` defaults to `false` to keep the main source graph
 * product-code-only. Tests are excluded via `isTestFile()` (defined in
 * `core/filter.ts`), which matches `tests/`, `__tests__/`, `*.test.*`,
 * `*.spec.*`, `test_*.py`, `*_test.go`, `*_test.rs`, etc.
 *
 * Opt-in: pass `{ includeTests: true }` or set the env var
 * `PI_SHAZAM_INCLUDE_TESTS=1`. The override is intended for callers who
 * explicitly need to inspect test code (e.g., `shazam_impact` "Affected
 * Tests" reporting) — not a default behavior.
 *
 * Issue #632: ~56% of pi-shazam's own source files are test files; their
 * presence polluted every downstream tool. Default-exclude ensures LLM
 * agents never have to disambiguate real symbols from test mocks.
 */
export interface ScanOptions {
	includeTests?: boolean;
}

/**
 * Read the `PI_SHAZAM_INCLUDE_TESTS` environment variable. Returns `true`
 * only when set to `"1"` — any other value (`"0"`, `"false"`, undefined)
 * leaves the default-exclude behavior in effect.
 *
 * Env-var read happens at scan time so process-state changes (e.g., tests
 * resetting env) take effect on the next `scanProject` call without
 * requiring a process restart.
 */
export function shouldIncludeTestsFromEnv(): boolean {
	return process.env.PI_SHAZAM_INCLUDE_TESTS === "1";
}

/**
 * Get (or build) the project graph with caching.
 * Returns a cached graph if no files have been modified since the last scan.
 * The cache is per-process (not persisted to disk).
 */
export function getProjectGraph(
	projectRoot: string = ".",
	log?: (msg: string) => void,
	options: ScanOptions = {},
): RepoGraph {
	const root = resolve(projectRoot);
	return scanProject(root, log, options);
}

// -- Scanner ------------------------------------------------------------------

/**
 * Find all files that depend on (import from) the given changed files.
 * Issue #469: replaces the O(changedFiles × |fileImports| × imports) nested
 * loop in scanIncremental with an O(total import edges) reverse-index build
 * followed by O(changedFiles) lookups. `fileImports` remains the single
 * source of truth; the reverse index is derived fresh per call and never
 * persisted, so it cannot drift.
 *
 * Returns a Set containing the changed files themselves plus every direct
 * importer of those files. Transitive importers are NOT included -- only
 * files that directly import a changed file. Behavior is identical to the
 * previous nested loop, only the algorithm changes.
 */
export function findDependentFiles(graph: RepoGraph, changedFiles: string[]): Set<string> {
	const dependentFiles = new Set<string>();
	// Build reverse index: imported target -> set of importer files.
	// One O(total import edges) pass replaces the per-changed-file scan
	// that previously iterated the entire fileImports map for each change.
	const importedBy = new Map<string, Set<string>>();
	for (const [importer, imports] of graph.fileImports) {
		for (const target of imports) {
			let importers = importedBy.get(target);
			if (!importers) {
				importers = new Set();
				importedBy.set(target, importers);
			}
			importers.add(importer);
		}
	}
	for (const relPath of changedFiles) {
		dependentFiles.add(relPath);
		const importers = importedBy.get(relPath);
		if (importers) {
			for (const importer of importers) {
				dependentFiles.add(importer);
			}
		}
	}
	return dependentFiles;
}

/**
 * Internal helper to clean edges for a set of symbols being removed.
 *
 * Handles the shared ~70 lines of edge cleanup that both removeEdgesForFile
 * and removeFileData perform:
 *   1. Clean incoming entries on targets of outgoing edges (Bug #4)
 *   2. Clean targetToSources entries (Issue #471 Finding C)
 *   3. Delete outgoing edges for each symbol
 *   4. Optionally delete incoming edges and symbols themselves
 *   5. Optionally clean cross-file references via reverse edge index
 *
 * Extracted to eliminate diverged duplicate between removeEdgesForFile
 * and removeFileData (issue #571 step 2).
 *
 * @param graph - The repo graph to mutate
 * @param symIds - Set of symbol IDs to clean edges for
 * @param preserveIncoming - When true, skip deleting incoming edges and
 *   cross-file source->B edges. Used for dependent (unchanged) files
 *   whose incoming edges are still valid (issue #448).
 * @param deleteSymbols - When true, also delete symbols from graph.symbols.
 *   Used by removeFileData which removes the file entirely.
 */
function _cleanEdgesForSymbols(
	graph: RepoGraph,
	symIds: Set<string>,
	preserveIncoming = false,
	deleteSymbols = false,
): void {
	// Clean incoming entries on targets of this file's outgoing edges
	// before deleting the outgoing map (Bug #4: prevent stale incoming refs)
	for (const id of symIds) {
		const outEdges = graph.outgoing.get(id);
		if (outEdges) {
			for (const edge of outEdges) {
				const targetIncoming = graph.incoming.get(edge.target);
				if (targetIncoming) {
					const filtered = targetIncoming.filter((e) => e.source !== id);
					if (filtered.length > 0) {
						graph.incoming.set(edge.target, filtered);
					} else {
						graph.incoming.delete(edge.target);
					}
				}
				// Issue #471 Finding C: also clean targetToSources on the SOURCE
				// side. When a source symbol in this file is deleted, we must
				// remove it from every target's targetToSources set to avoid
				// stale entries pointing to a non-existent source.
				const targetSources = graph.targetToSources.get(edge.target);
				if (targetSources) {
					targetSources.delete(id);
					if (targetSources.size === 0) {
						graph.targetToSources.delete(edge.target);
					}
				}
			}
		}
		if (deleteSymbols) graph.symbols.delete(id);
		graph.outgoing.delete(id);
		if (!preserveIncoming) graph.incoming.delete(id);
	}

	// Use reverse edge index to clean cross-file references: O(K) not O(E).
	// Skip when preserveIncoming is true -- the cross-file source->B edges
	// pointing into this file are still valid for unchanged dependents (issue #448).
	if (!preserveIncoming) {
		for (const targetId of symIds) {
			const sourceIds = graph.targetToSources.get(targetId);
			if (!sourceIds) continue;
			for (const sourceId of sourceIds) {
				// Remove edges pointing to targetId from source's outgoing
				const edges = graph.outgoing.get(sourceId);
				if (edges) {
					const filtered = edges.filter((e) => e.target !== targetId);
					if (filtered.length > 0) {
						graph.outgoing.set(sourceId, filtered);
					} else {
						graph.outgoing.delete(sourceId);
					}
				}
				// incoming[targetId] already deleted above; clean incoming[sourceId] for edges with source=targetId
				const incomingEdges = graph.incoming.get(sourceId);
				if (incomingEdges) {
					const filtered = incomingEdges.filter((e) => e.source !== targetId);
					if (filtered.length > 0) {
						graph.incoming.set(sourceId, filtered);
					} else {
						graph.incoming.delete(sourceId);
					}
				}
			}
			graph.targetToSources.delete(targetId);
		}
	}
}

/**
 * Remove only the edges for a single file (not symbols).
 * Used during incremental edge rebuild to clear old edges before
 * rebuilding only what changed.
 *
 * @param preserveIncoming - When true, skip deleting this file's own incoming
 *   entries and cross-file source->B edges. Used for dependent (unchanged)
 *   files whose incoming edges are still valid -- only outgoing edges need
 *   rebuilding (issue #448).
 */
export function removeEdgesForFile(graph: RepoGraph, relPath: string, preserveIncoming = false): void {
	const symIds = new Set(graph.fileSymbols.get(relPath) ?? []);
	_cleanEdgesForSymbols(graph, symIds, preserveIncoming);
	// Remove file-level import/call data for this file
	graph.fileImports.delete(relPath);
	graph.fileCalls.delete(relPath);
	graph.fileImportBindings.delete(relPath);
	graph.fileRefs.delete(relPath);
	graph.fileTypeRefs.delete(relPath);
}

export function removeFileData(graph: RepoGraph, relPath: string): void {
	const symIds = graph.fileSymbols.get(relPath) || [];
	const symIdSet = new Set(symIds);

	// Collect names before deleting symbols, for nameIndex cleanup.
	// Use a Set to deduplicate -- when multiple symbols in the file share a
	// name, we only filter that name's index once (issue #469: avoids
	// O(N×M) where N = symbols in file, M = global symbols per name).
	const symNames = new Set<string>();
	for (const id of symIds) {
		const sym = graph.symbols.get(id);
		if (sym) symNames.add(sym.name);
	}

	_cleanEdgesForSymbols(graph, symIdSet, false, true);
	graph.fileSymbols.delete(relPath);
	graph.fileImports.delete(relPath);
	graph.fileCalls.delete(relPath);
	graph.fileImportBindings.delete(relPath);
	graph.fileRefs.delete(relPath);
	graph.fileTypeRefs.delete(relPath);

	// Remove this file's symbols from nameIndex.
	// Iterating the deduplicated name Set avoids re-filtering the same
	// nameIndex array multiple times when the file had same-named symbols
	// (issue #469).
	for (const name of symNames) {
		const named = graph.nameIndex.get(name);
		if (named) {
			const filtered = named.filter((s) => !symIdSet.has(s.id));
			if (filtered.length > 0) {
				graph.nameIndex.set(name, filtered);
			} else {
				graph.nameIndex.delete(name);
			}
		}
	}
}

/**
 * Extract names listed in a Python `__all__ = [...]` declaration at module
 * scope. Used to mark those symbols as exported (issue #248).
 *
 * Returns an empty set when no __all__ is found or when the value cannot
 * be statically parsed (e.g. non-literal expressions).
 *
 * Tree/SyntaxNode are real types re-exported from core/treesitter.ts (#659),
 * so no `as` casts are needed to read node shapes.
 */
function extractPythonAllNames(tree: Tree): Set<string> {
	const names = new Set<string>();
	const rootNode = tree.rootNode;
	if (!rootNode) return names;
	for (const top of rootNode.namedChildren ?? []) {
		// Module-level statements are either `expression_statement`
		// wrapping an `assignment`, or (in some grammar versions) a
		// direct `assignment` node.
		let assignment: SyntaxNode | null = null;
		if (top.type === "expression_statement") {
			assignment = top.children[0] ?? null;
		} else if (top.type === "assignment") {
			assignment = top;
		}
		if (!assignment) continue;

		const children = assignment.children;
		const lhs = children.find((c) => c.type === "identifier" && c.text === "__all__");
		if (!lhs) continue;

		// RHS may be a direct `list` or a `binary_operator` for
		// `__all__ = ["a"] + ["b"]` concatenation.
		const rhs = children.find((c) => c.type === "list" || c.type === "binary_operator");
		if (!rhs) continue;
		collectStringsFromNode(rhs, names);
		return names;
	}
	return names;
}

function collectStringsFromNode(node: SyntaxNode, out: Set<string>): void {
	if (node.type === "string") {
		const text = node.text;
		// Strip quotes: 'x', "x", '''x''', """x"""
		// Handle triple-quoted strings by matching 1-3 quote characters
		const inner = text.replace(/^([fruUbB]*)["']{1,3}/, "").replace(/["']{1,3}$/, "");
		out.add(inner);
		return;
	}
	if (!node.namedChildren) return;
	for (const child of node.namedChildren) {
		collectStringsFromNode(child, out);
	}
}

/**
 * Parse a single file and extract symbols, imports, calls, and JS/TS import bindings.
 * Returns a FileCacheEntry with all extracted data.
 */
function parseFile(adapter: TreeSitterAdapter, root: string, relPath: string, mtime: number): FileCacheEntry | null {
	const absPath = join(root, relPath);
	const ext = relPath.slice(relPath.lastIndexOf(".")).toLowerCase();
	const lang = EXT_TO_LANG[ext];
	if (!lang) return null;

	try {
		const source = readFileAdaptive(absPath);
		const tree = adapter.parse(source, lang);
		if (!tree) return null;

		try {
			const symbols = adapter.extractSymbols(tree, lang, relPath);
			// For Python files, scan for `__all__ = [...]` at module scope and
			// mark listed symbols as exported. Symbols in __all__ are the
			// module's public API; consumers import them by name from outside
			// the scanned graph, so without this they appear orphaned (#248).
			if (lang === "python") {
				const allNames = extractPythonAllNames(tree);
				if (allNames.size > 0) {
					for (const sym of symbols) {
						if (allNames.has(sym.name)) sym.visibility = "exported";
					}
				}
			}
			const imports = adapter.extractImports(tree, lang);
			const calls = adapter.extractCalls(tree, lang);
			const refs = adapter.extractRefs(tree, lang);
			const typeRefs = adapter.extractTypeRefs(tree, lang);
			const jsImportBindings = adapter.extractJsTsImportBindings(tree, lang);

			return { mtime, symbols, imports, calls, refs, typeRefs, jsImportBindings };
		} finally {
			tree.delete?.();
		}
	} catch (err) {
		// Log parse failures to aid debugging (fixes #133)
		if (err instanceof FileTooLargeError) {
			// Expected for large files -- skip silently
			return null;
		}
		_logWarn("parseFile", `failed to parse ${relPath}`, err);
		return null;
	}
}

/**
 * Build edges for a single file using its cached parse data and the current graph state.
 */
function buildEdgesForFile(graph: RepoGraph, root: string, relPath: string, entry: FileCacheEntry): void {
	const thisFileSymIds = graph.fileSymbols.get(relPath) || [];

	// Pre-sort symbols by line for O(log S) binary search in findCallerSymbols.
	// Sorting once per file avoids the O(S log S) sort on every call/ref lookup.
	const sortedFileSymIds =
		thisFileSymIds.length > 1
			? [...thisFileSymIds].sort((a, b) => {
					const sa = graph.symbols.get(a);
					const sb = graph.symbols.get(b);
					return (sa?.line ?? 0) - (sb?.line ?? 0);
				})
			: thisFileSymIds;

	// Import edges — resolve each import once, reuse for both
	// fileImports (for dependent detection) and edge creation.
	if (entry.imports.length > 0) {
		const resolvedImports: string[] = [];
		for (const [importedModule] of entry.imports) {
			const resolvedImport = resolveImport(importedModule, relPath, root, graph);
			if (!resolvedImport) continue;
			resolvedImports.push(resolvedImport);
			const targetFileSyms = graph.fileSymbols.get(resolvedImport) || [];
			for (const srcId of thisFileSymIds) {
				for (const tgtId of targetFileSyms) {
					addEdge(graph, createEdge(srcId, tgtId, 0.3, "import", 0.5));
				}
			}
		}
		graph.fileImports.set(relPath, resolvedImports);
	}

	// Call edges
	if (entry.calls.length > 0) {
		graph.fileCalls.set(relPath, entry.calls);
		for (const [calledName, callLine] of entry.calls) {
			const callerSyms = findCallerSymbols(sortedFileSymIds, graph.symbols, callLine);
			const calleeSyms = findCalleeSymbols(calledName, graph);
			for (const caller of callerSyms) {
				for (const callee of calleeSyms) {
					if (caller.id !== callee.id) {
						addEdge(graph, createEdge(caller.id, callee.id, 1.0, "call", 0.9));
					}
				}
			}
		}
	}

	// Ref edges -- same-file identifier references (callbacks/event handlers etc.)
	if (entry.refs.length > 0) {
		graph.fileRefs.set(relPath, entry.refs);
		for (const [refName, refLine] of entry.refs) {
			const callerSyms = findCallerSymbols(sortedFileSymIds, graph.symbols, refLine);
			const calleeSym = findSymbolByNameInFile(refName, relPath, graph);
			if (calleeSym) {
				for (const caller of callerSyms) {
					if (caller.id !== calleeSym.id) {
						addEdge(graph, createEdge(caller.id, calleeSym.id, 0.5, "ref", 0.9));
					}
				}
			}
		}
	}

	// Type reference edges -- type annotations, extends/implements, generic args (issue #542)
	if (entry.typeRefs.length > 0) {
		graph.fileTypeRefs.set(relPath, entry.typeRefs);
		for (const [typeName, typeLine] of entry.typeRefs) {
			// Find the enclosing symbol that contains this type reference
			const callerSyms = findCallerSymbols(sortedFileSymIds, graph.symbols, typeLine);
			// Type references can be cross-file (like calls), search all symbols by name
			const targetSyms = findCalleeSymbols(typeName, graph);
			for (const caller of callerSyms) {
				for (const target of targetSyms) {
					if (caller.id !== target.id) {
						addEdge(graph, createEdge(caller.id, target.id, 0.4, "type", 0.8));
					}
				}
			}
		}
	}

	// JS/TS import bindings
	if (entry.jsImportBindings.length > 0) {
		graph.fileImportBindings.set(relPath, entry.jsImportBindings);
		for (const binding of entry.jsImportBindings) {
			const localSym = findSymbolByNameInFile(binding.localName, relPath, graph);
			if (!localSym) continue;
			const resolvedModule = resolveImport(binding.module, relPath, root, graph);
			if (!resolvedModule) continue;
			const sourceSym = findSymbolByNameInFile(binding.importedName, resolvedModule, graph);
			if (sourceSym) {
				addEdge(graph, createEdge(localSym.id, sourceSym.id, 0.8, "import-binding", 1.0));
			}
		}
	}
}

/**
 * Get the persistent graph cache file path for a project.
 */
function getGraphCachePath(projectRoot: string): string {
	return join(getProjectCacheDir(projectRoot), "graph-cache.json");
}

/**
 * Scan a project directory, parse all source files, build the dependency graph,
 * and compute PageRank scores.
 *
 * Supports persistent caching: on first call, loads from disk cache if available
 * and validates file mtimes. If all files match, returns cached graph instantly.
 * If some files changed, loads cache and does incremental update.
 * Falls back to full scan when no cache exists.
 *
 * @param projectPath - Absolute or relative path to the project root
 * @param log - Optional logger
 * @param options - Scan policy. `includeTests` defaults to `false` (excludes test
 *   files via `isTestFile()`). Override per-call with `{ includeTests: true }`
 *   or globally via env var `PI_SHAZAM_INCLUDE_TESTS=1`. See issue #632.
 * @returns The fully built RepoGraph with PageRank scores set
 */
export function scanProject(projectPath: string, log?: (msg: string) => void, options: ScanOptions = {}): RepoGraph {
	enterScan();
	try {
		// C3: When caller passes "." (default project path), use the configured
		// project root override if one was set by index.ts from Pi's ctx.cwd.
		// This ensures scanner and LSP use the same project root.
		const effectivePath = projectPath === "." && _projectRootOverride ? _projectRootOverride : projectPath;
		return _scanProject(effectivePath, log, options);
	} finally {
		exitScan();
		// M11: Reset _scanSeenEdges in finally block so it doesn't leak across scans
		_scanSeenEdges = null;
	}
}

function _scanProject(projectPath: string, log?: (msg: string) => void, options: ScanOptions = {}): RepoGraph {
	const root = resolve(projectPath);
	const logger = log ?? (() => {});

	// Clear existsCache so each scan observes current filesystem state
	clearExistsCache();

	const adapter = getScannerAdapter();
	// Issue #632: tests are excluded from the default graph. Callers opt in
	// via `options.includeTests` or the `PI_SHAZAM_INCLUDE_TESTS=1` env var.
	const includeTests = options.includeTests ?? shouldIncludeTestsFromEnv();
	const collected = collectSourceFiles(root, MAX_FILES, includeTests);
	const { files, truncated, excludedTestCount } = collected;
	logger(`Scanned ${files.length} source files`);
	// Issue #471 Finding A: warn when the file cap was hit so the agent is
	// incomplete, instead of silently returning a truncated graph with no indication.
	if (truncated) {
		_logWarn(
			"scanProject",
			`MAX_FILES limit reached (${MAX_FILES}) — additional source files skipped. Graph may be incomplete`,
		);
	}
	// Issue #632: observable signal that tests were excluded by default. Only
	// logs once per scan (here), not on every tool call. Opt-in via env var
	// disables the warning by including the files.
	if (!includeTests && excludedTestCount > 0) {
		_logWarn(
			"scanProject",
			`Excluded ${excludedTestCount} test files from graph. Set PI_SHAZAM_INCLUDE_TESTS=1 to include them.`,
		);
	}

	// Check in-memory cache first (same process, fastest path)
	const isInMemory = cachedGraph !== null && cachedProjectPath === root && cachedFiles.size > 0;
	if (isInMemory) {
		const incremental = scanIncremental(root, files, adapter, logger);
		recordExcludedTestCount(incremental, excludedTestCount);
		incremental.truncated = truncated;
		return incremental;
	}

	// Try persistent disk cache
	const cachePath = getGraphCachePath(root);
	const diskCache = loadGraphCache(cachePath);
	if (diskCache) {
		const fileMtimes = getFileMtimes(root, files);
		const currentFileSet = new Set(files);
		const cachedFileSet = new Set(diskCache.fileMtimes.keys());

		// Detect changes
		const changedFiles: string[] = [];
		const newFiles: string[] = [];
		const deletedFiles: string[] = [];

		for (const relPath of files) {
			const currentMtime = fileMtimes.get(relPath) ?? 0;
			const cachedMtime = diskCache.fileMtimes.get(relPath);
			if (cachedMtime === undefined) {
				newFiles.push(relPath);
			} else if (cachedMtime < currentMtime) {
				changedFiles.push(relPath);
			}
		}
		for (const relPath of cachedFileSet) {
			if (!currentFileSet.has(relPath)) {
				deletedFiles.push(relPath);
			}
		}

		const hasChanges = changedFiles.length > 0 || newFiles.length > 0 || deletedFiles.length > 0;

		if (!hasChanges) {
			// All mtimes match -- use cached graph directly
			logger(`Cache hit: ${diskCache.graph.symbols.size} symbols loaded from disk`);
			cachedGraph = diskCache.graph;
			cachedProjectPath = root;
			cachedFiles = reconstructFileCache(diskCache.graph, diskCache.fileMtimes);
			recordExcludedTestCount(cachedGraph, excludedTestCount);
			return cachedGraph;
		}

		// Some files changed -- load cache into memory, then incremental
		logger(`Cache partial hit: ${changedFiles.length} changed, ${newFiles.length} new, ${deletedFiles.length} deleted`);
		cachedGraph = diskCache.graph;
		cachedProjectPath = root;
		cachedFiles = reconstructFileCache(diskCache.graph, diskCache.fileMtimes);
		const updatedGraph = scanIncremental(root, files, adapter, logger);

		// Persist updated graph to disk
		try {
			const saveFileMtimes = getFileMtimes(root, files);
			saveGraphCache(updatedGraph, saveFileMtimes, cachePath);
			logger(`Graph cache updated: ${updatedGraph.symbols.size} symbols`);
		} catch (err) {
			_logWarn("scanProject", "Failed to save graph cache (incremental)", err);
			logger(`Failed to save graph cache: ${err}`);
		}

		recordExcludedTestCount(updatedGraph, excludedTestCount);
		updatedGraph.truncated = truncated;
		return updatedGraph;
	}

	// No cache -- full scan
	const graph = scanFull(root, files, adapter, logger);
	recordExcludedTestCount(graph, excludedTestCount);

	// Save to persistent cache
	try {
		const saveFileMtimes = getFileMtimes(root, files);
		saveGraphCache(graph, saveFileMtimes, cachePath);
		logger(`Graph cache saved: ${graph.symbols.size} symbols`);
	} catch (err) {
		_logWarn("scanProject", "Failed to save graph cache (full)", err);
		logger(`Failed to save graph cache: ${err}`);
	}

	graph.truncated = truncated;
	return graph;
}

/**
 * Reconstruct the per-file cache entries from a deserialized graph and mtimes.
 * Symbols are resolved from graph.symbols by ID; imports/calls/bindings are
 * restored from the graph's file-level maps.
 */
function reconstructFileCache(graph: RepoGraph, fileMtimes: Map<string, number>): Map<string, FileCacheEntry> {
	const entries = new Map<string, FileCacheEntry>();

	for (const [relPath, mtime] of fileMtimes) {
		const symIds = graph.fileSymbols.get(relPath) || [];
		const symbols: Symbol[] = [];
		for (const id of symIds) {
			const sym = graph.symbols.get(id);
			if (sym) symbols.push(sym);
		}

		const importModules = graph.fileImports.get(relPath) || [];
		const imports: [string, number][] = importModules.map((m) => [m, 0]);

		const calls = graph.fileCalls.get(relPath) || [];
		const refs: [string, number][] = graph.fileRefs.get(relPath) || [];
		const typeRefs: [string, number][] = graph.fileTypeRefs.get(relPath) || [];
		const jsImportBindings = graph.fileImportBindings.get(relPath) || [];

		entries.set(relPath, { mtime, symbols, imports, calls, refs, typeRefs, jsImportBindings });
	}

	return entries;
}

/**
 * Full scan: parse all files from scratch.
 */
function scanFull(root: string, files: string[], adapter: TreeSitterAdapter, logger: (msg: string) => void): RepoGraph {
	const graph = createRepoGraph();
	const newFileCache = new Map<string, FileCacheEntry>();
	_scanSeenEdges = new Set<string>();
	const skippedFiles: string[] = [];

	// Phase 1: Parse all files and extract data
	const fileMtimes = getFileMtimes(root, files);
	for (const relPath of files) {
		const mtime = fileMtimes.get(relPath) ?? 0;
		const entry = parseFile(adapter, root, relPath, mtime);
		if (!entry) {
			skippedFiles.push(relPath);
			continue;
		}

		newFileCache.set(relPath, entry);

		// Add symbols to graph
		for (const sym of entry.symbols) {
			graph.symbols.set(sym.id, sym);
			const named = graph.nameIndex.get(sym.name);
			if (named) {
				named.push(sym);
			} else {
				graph.nameIndex.set(sym.name, [sym]);
			}
			const fileSyms = graph.fileSymbols.get(relPath) || [];
			fileSyms.push(sym.id);
			graph.fileSymbols.set(relPath, fileSyms);
		}

		// Ensure file is in graph even with 0 symbols (e.g., test files with no exports)
		if (!graph.fileSymbols.has(relPath)) {
			graph.fileSymbols.set(relPath, []);
		}
	}

	logger(`Extracted ${graph.symbols.size} symbols`);

	// Phase 2: Build edges for all files
	for (const [relPath, entry] of newFileCache) {
		buildEdgesForFile(graph, root, relPath, entry);
	}

	// Phase 3: Compute PageRank
	calculatePageRank(graph);

	// Update caches
	cachedGraph = graph;
	cachedProjectPath = root;
	cachedFiles = newFileCache;
	_scanSeenEdges = null;

	if (skippedFiles.length > 0) {
		logger(`Skipped ${skippedFiles.length} files (too large or unparseable)`);
	}

	return graph;
}

/**
 * Incremental scan: only re-parse files whose mtime changed.
 * Reuses cached parse data for unchanged files.
 */
function scanIncremental(
	root: string,
	files: string[],
	adapter: TreeSitterAdapter,
	logger: (msg: string) => void,
): RepoGraph {
	const graph = cachedGraph!;
	const fileMtimes = getFileMtimes(root, files);
	const currentFileSet = new Set(files);

	// Determine changed, new, and deleted files
	// Note: "changedFiles" includes both new files (not in cache) and modified files
	const changedFiles: string[] = [];
	const deletedFiles: string[] = [];

	for (const relPath of files) {
		const mtime = fileMtimes.get(relPath) ?? 0;
		const cached = cachedFiles.get(relPath);
		if (!cached || cached.mtime < mtime) {
			changedFiles.push(relPath);
		}
	}

	for (const [relPath] of cachedFiles) {
		if (!currentFileSet.has(relPath)) {
			deletedFiles.push(relPath);
		}
	}

	if (changedFiles.length === 0 && deletedFiles.length === 0) {
		return graph;
	}

	logger(`Incremental: ${changedFiles.length} changed, ${deletedFiles.length} deleted`);

	// Remove deleted files
	for (const relPath of deletedFiles) {
		removeFileData(graph, relPath);
		cachedFiles.delete(relPath);
	}

	// Snapshot old symbol IDs AND their incoming edges for changed files
	// BEFORE modifying graph, so edge rebuild can trace callers across
	// non-import edges (issue #93) and cross-file calls (issue #284).
	const oldSymIdsByFile = new Map<string, Set<string>>();
	const oldIncomingBySymId = new Map<string, Edge[]>();
	for (const relPath of changedFiles) {
		const oldIds = new Set(graph.fileSymbols.get(relPath) ?? []);
		oldSymIdsByFile.set(relPath, oldIds);
		for (const id of oldIds) {
			const incoming = graph.incoming.get(id);
			if (incoming) oldIncomingBySymId.set(id, incoming);
		}
	}

	// Re-parse changed files -- delay removeFileData until after parse succeeds
	// to avoid the rollback path that restores symbols but not edges (#156).
	for (const relPath of changedFiles) {
		const mtime = fileMtimes.get(relPath) ?? 0;
		const entry = parseFile(adapter, root, relPath, mtime);
		if (!entry) {
			// Re-parse failed -- keep old data untouched (no rollback needed)
			continue;
		}

		// Parse succeeded -- remove old data and replace with new
		removeFileData(graph, relPath);
		cachedFiles.delete(relPath);
		cachedFiles.set(relPath, entry);

		for (const sym of entry.symbols) {
			graph.symbols.set(sym.id, sym);
			const named = graph.nameIndex.get(sym.name);
			if (named) {
				named.push(sym);
			} else {
				graph.nameIndex.set(sym.name, [sym]);
			}
			const fileSyms = graph.fileSymbols.get(relPath) || [];
			fileSyms.push(sym.id);
			graph.fileSymbols.set(relPath, fileSyms);
		}

		// Ensure file is in graph even with 0 symbols (e.g., test files with no exports)
		if (!graph.fileSymbols.has(relPath)) {
			graph.fileSymbols.set(relPath, []);
		}
	}

	// Rebuild edges only for changed files and files that depend on them.
	// Previously this cleared ALL edges and rebuilt for every file (O(N)),
	// negating the benefit of incremental scanning for large projects.
	// oldSymIdsByFile was built above before removeFileData calls.

	_scanSeenEdges = new Set<string>();

	// Find files that import from changed files (dependents).
	// Issue #469: use findDependentFiles (reverse-import lookup) instead of
	// the O(changedFiles × |fileImports| × imports) nested loop. The helper
	// builds a fresh reverse index per call -- fileImports stays the source
	// of truth. L1: removeEdgesForFile is done in the dependentFiles loop
	// below which includes changedFiles as a subset.
	const dependentFiles = findDependentFiles(graph, changedFiles);

	// Trace cross-file call edges using the snapshot (Bug #2 fix):
	// files whose symbols had incoming edges from the changed file's old
	// symbols need their edges rebuilt.
	// Use nameIndex for caller lookup -- more robust than graph.symbols.get()
	// when symbols may have been removed during incremental rebuild (#319).
	for (const [, oldIds] of oldSymIdsByFile) {
		for (const oldId of oldIds) {
			const incoming = oldIncomingBySymId.get(oldId);
			if (!incoming) continue;
			for (const edge of incoming) {
				// Extract caller name from edge.source ID (format: file::name::line)
				const lastSep = edge.source.lastIndexOf("::");
				const namePart = lastSep > -1 ? edge.source.slice(edge.source.indexOf("::") + 2, lastSep) : "";
				if (namePart) {
					const nameMatches = graph.nameIndex.get(namePart);
					if (nameMatches) {
						for (const sym of nameMatches) {
							if (sym.id === edge.source) {
								dependentFiles.add(sym.file);
								break;
							}
						}
					}
				}
			}
		}
	}

	// Rebuild edges only for changed + dependent files.
	// Clear edges for dependent files first (Bug #3 fix) to prevent
	// duplicate edge accumulation across incremental scans.
	// Use preserveIncoming=true for dependent files: they are unchanged,
	// so their incoming edges are still valid and must not be deleted (issue #448).
	for (const relPath of dependentFiles) {
		const entry = cachedFiles.get(relPath);
		if (entry) {
			removeEdgesForFile(graph, relPath, true);
			buildEdgesForFile(graph, root, relPath, entry);
		}
	}

	_scanSeenEdges = null;

	// Recompute PageRank
	calculatePageRank(graph);

	return graph;
}

// -- File collection ----------------------------------------------------------

/**
 * Walk a project tree and return source files. When `includeTests` is false
 * (the default), test files matching `isTestFile()` are excluded from the
 * returned list — but the count is tracked in `excludedTestCount` so the
 * caller can surface it as a footnote (issue #632).
 */
export function collectSourceFiles(
	root: string,
	maxFiles: number,
	includeTests: boolean = shouldIncludeTestsFromEnv(),
): { files: string[]; truncated: boolean; excludedTestCount: number } {
	const options = {
		root,
		maxFiles,
		maxDepth: 50,
		files: [] as string[],
		visitedSymlinks: new Set<string>(),
		truncated: false,
		includeTests,
		excludedTestCount: 0,
		// Issue #720: wall-clock budget. 0 disables the deadline entirely.
		// The deadline is captured at the start of the walk so we compare
		// against a stable anchor; reading Date.now() once avoids drift if
		// the env var is mutated mid-walk.
		deadlineStartMs: Date.now(),
		deadlineMs: getScanDeadlineMs(),
	};
	_walkDirectory(root, 0, options);
	// Surface the deadline-budget breach as a one-shot warning so the
	// agent knows the graph may be incomplete (mirrors the MAX_FILES
	// warning at the call site -- see _scanProject).
	if (options.deadlineMs > 0 && Date.now() - options.deadlineStartMs >= options.deadlineMs) {
		options.truncated = true;
		_logWarn(
			"collectSourceFiles",
			`scan deadline exceeded (${options.deadlineMs} ms) -- graph may be incomplete. ` +
				`Tune via PI_SHAZAM_SCAN_DEADLINE_MS.`,
		);
	}
	return { files: options.files, truncated: options.truncated, excludedTestCount: options.excludedTestCount };
}

function _walkDirectory(
	dir: string,
	depth: number,
	options: {
		root: string;
		maxFiles: number;
		maxDepth: number;
		files: string[];
		visitedSymlinks: Set<string>;
		truncated: boolean;
		includeTests: boolean;
		excludedTestCount: number;
		deadlineStartMs: number;
		deadlineMs: number;
	},
): void {
	const { root, maxFiles, maxDepth, files, visitedSymlinks } = options;
	if (files.length >= maxFiles) {
		options.truncated = true;
		return;
	}
	if (depth > maxDepth) return;
	// Issue #720: stop walking when the wall-clock budget is exhausted.
	// The caller's collectSourceFiles() emits the user-facing warning; we
	// only flip the truncated flag so the outer scan path also knows to
	// mark the graph incomplete.
	if (options.deadlineMs > 0 && Date.now() - options.deadlineStartMs >= options.deadlineMs) {
		options.truncated = true;
		return;
	}

	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		// Log directory read failures (fixes #133, #160)
		if (err instanceof Error && (err.message.includes("EACCES") || err.message.includes("EPERM"))) {
			_logWarn("_walkDirectory", `permission denied: ${dir}`, err);
		} else {
			_logWarn("_walkDirectory", `unexpected error reading ${dir}`, err);
		}
		return;
	}

	for (const entry of entries) {
		if (files.length >= maxFiles) {
			options.truncated = true;
			return;
		}

		const relPath = relative(root, join(dir, entry.name));

		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			_walkDirectory(join(dir, entry.name), depth + 1, options);
		} else if (entry.isSymbolicLink()) {
			// Resolve symlink to check whether it points to a directory or file.
			// Use statSync (not lstatSync) to follow the symlink and get the
			// target's actual type (isDirectory reflects the target, not the link).
			try {
				const realStat = statSync(join(dir, entry.name));
				if (realStat.isDirectory()) {
					// Symlink cycle detection: skip if we already visited this realpath
					const realPath = realpathSync(join(dir, entry.name));
					if (visitedSymlinks.has(realPath)) {
						_logWarn("_walkDirectory", `skipping symlink cycle: ${relPath}`);
						continue;
					}
					visitedSymlinks.add(realPath);
					// Directory symlink containment check: use relative() instead of
					// startsWith(root + "/") for cross-platform correctness (#570).
					const resolvedRoot = resolve(root);
					const relToRoot = relative(resolvedRoot, realPath);
					if (relToRoot !== "" && (relToRoot.startsWith("..") || isAbsolute(relToRoot))) {
						_logWarn("_walkDirectory", `symlink target outside project root, skipping: ${relPath} -> ${realPath}`);
						continue;
					}
					_walkDirectory(realPath, depth + 1, options);
					continue;
				}
				// File symlink: validate target is within project root (C4: path traversal),
				// then treat as regular file (C1: was silently skipped before).
				const realPath = realpathSync(join(dir, entry.name));
				const resolvedRoot = resolve(root);
				const relToRoot = relative(resolvedRoot, realPath);
				if (relToRoot !== "" && (relToRoot.startsWith("..") || isAbsolute(relToRoot))) {
					_logWarn("_walkDirectory", `symlink target outside project root, skipping: ${relPath} -> ${realPath}`);
					continue;
				}
				tryAddSourceFile(options, relPath, entry.name);
			} catch (err) {
				_logWarn("_walkDirectory", `broken symlink: ${relPath}`, err);
				continue; // broken symlink, skip
			}
		} else if (entry.isFile()) {
			tryAddSourceFile(options, relPath, entry.name);
		}
	}
}

/**
 * Apply SOURCE_EXTS filtering and (when `includeTests` is false) the
 * `isTestFile` policy to one entry. Issue #632: keeps the test-exclusion
 * policy in one place so future expansions (e.g. exclude docs) only need
 * to change one branch instead of two identical inline blocks.
 */
function tryAddSourceFile(
	options: {
		files: string[];
		excludedTestCount: number;
		includeTests: boolean;
	},
	relPath: string,
	entryName: string,
): void {
	const ext = entryName.slice(entryName.lastIndexOf(".")).toLowerCase();
	if (!SOURCE_EXTS.has(ext)) return;
	if (!options.includeTests && isTestFile(relPath)) {
		options.excludedTestCount++;
		return;
	}
	options.files.push(relPath);
}

// -- Edge helpers -------------------------------------------------------------

// Per-scan set of seen edge keys to prevent duplicates (#319).
let _scanSeenEdges: Set<string> | null = null;

function addEdge(graph: RepoGraph, edge: Edge): void {
	// Deduplicate edges within a single scan using a compound key.
	if (_scanSeenEdges) {
		const key = `${edge.source}::${edge.target}::${edge.kind}`;
		if (_scanSeenEdges.has(key)) return;
		_scanSeenEdges.add(key);
	}

	const outgoing = graph.outgoing.get(edge.source) || [];
	outgoing.push(edge);
	graph.outgoing.set(edge.source, outgoing);

	const incoming = graph.incoming.get(edge.target) || [];
	incoming.push(edge);
	graph.incoming.set(edge.target, incoming);

	// Maintain reverse edge index
	const sources = graph.targetToSources.get(edge.target);
	if (sources) {
		sources.add(edge.source);
	} else {
		graph.targetToSources.set(edge.target, new Set([edge.source]));
	}
}

// -- Import resolution (delegated to core/resolve-import.ts) -------------------

// tryCandidate and resolveImport are now imported from core/resolve-import.js.
// They were moved there to share import resolution logic with filter.ts
// (issue #571 step 8).

// -- Symbol lookup helpers ----------------------------------------------------

// fileSymIds MUST be pre-sorted by symbol line (ascending) before calling.
// Uses binary search O(log S) to find the index range, then bounded linear
// scan to pick the narrowest-range symbol that contains callLine.
function findCallerSymbols(fileSymIds: string[], symbols: Map<string, Symbol>, callLine: number): Symbol[] {
	// Binary search: find the last index where symbols[id].line <= callLine
	let lo = 0;
	let hi = fileSymIds.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const sym = symbols.get(fileSymIds[mid]!);
		if (sym && sym.line <= callLine) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	// Scan backward from lo-1 (closest matches first) to find the symbol
	// with narrowest range that still contains callLine.
	let bestSym: Symbol | null = null;
	let bestRange = Infinity;
	for (let i = lo - 1; i >= 0; i--) {
		const sym = symbols.get(fileSymIds[i]!);
		if (!sym) continue;
		if (callLine > sym.endLine) continue; // symbol ended before callLine — stop scanning
		const range = sym.endLine - sym.line;
		if (range < bestRange) {
			bestRange = range;
			bestSym = sym;
		}
	}
	return bestSym ? [bestSym] : [];
}

function findCalleeSymbols(name: string, graph: RepoGraph): Symbol[] {
	// Use nameIndex for O(1) lookup
	if (graph.nameIndex.size > 0) {
		return graph.nameIndex.get(name) ?? [];
	}
	// Fallback to O(N) scan (e.g., after deserialization before index is built)
	const results: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === name) {
			results.push(sym);
		}
	}
	return results;
}

function findSymbolByNameInFile(name: string, file: string, graph: RepoGraph): Symbol | undefined {
	if (graph.nameIndex.size > 0) {
		const candidates = graph.nameIndex.get(name);
		if (candidates) {
			for (const sym of candidates) {
				if (sym.file === file) return sym;
			}
		}
		return undefined;
	}
	// Fallback to O(N) scan
	for (const sym of graph.symbols.values()) {
		if (sym.file === file && sym.name === name) {
			return sym;
		}
	}
	return undefined;
}

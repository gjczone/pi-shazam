/**
 * pi-shazam core/scanner — Project scanning + graph building.
 *
 * Walks project directories, parses source files with tree-sitter,
 * extracts symbols/imports/calls, and builds the full RepoGraph.
 *
 * This is the main entry point that all tools compose from.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { TreeSitterAdapter, EXT_TO_LANG } from "./treesitter.js";
import { createRepoGraph, createEdge } from "./graph.js";
import type { RepoGraph, Symbol, Edge } from "./graph.js";
import { calculatePageRank } from "./pagerank.js";
import { readFileAdaptive } from "./encoding.js";
import { getProjectCacheDir, saveGraphCache, loadGraphCache } from "./cache.js";
import { SKIP_DIRS } from "./filter.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum files to scan (safety limit) */
const MAX_FILES = 20_000;

/** File extensions to scan */
const SOURCE_EXTS = new Set(Object.keys(EXT_TO_LANG));

// ── In-memory cache ─────────────────────────────────────────────────────────

let cachedGraph: RepoGraph | null = null;
let cachedProjectPath: string = "";

// ── Concurrency guard (issue #92) ───────────────────────────────────────────
// While Node.js is single-threaded and scanProject() is fully synchronous,
// this mutex prevents re-entrant calls (e.g., scanProject called from within
// a tool that itself was triggered by another scanProject invocation).
let _scanning = false;
function enterScan(): void {
	if (_scanning) throw new Error("Re-entrant scanProject detected — this is a bug");
	_scanning = true;
}
function exitScan(): void { _scanning = false; }

interface FileCacheEntry {
	mtime: number;
	symbols: Symbol[];
	imports: [string, number][];
	calls: [string, number, string][];
	jsImportBindings: import("./graph.js").JSImportBinding[];
}

let cachedFiles: Map<string, FileCacheEntry> = new Map();

/**
 * Reset all in-memory caches. Used in tests and when cache may be stale.
 */
export function resetCache(): void {
	cachedGraph = null;
	cachedProjectPath = "";
	cachedFiles = new Map();
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
			// Log but continue — file may have been deleted between collection and stat
			if (err instanceof Error && err.message.includes('ENOENT')) continue;
			console.warn(`[pi-shazam] getFileMtimes: failed to stat ${relPath}: ${err}`);
		}
	}
	return mtimes;
}

/**
 * Get (or build) the project graph with caching.
 * Returns a cached graph if no files have been modified since the last scan.
 * The cache is per-process (not persisted to disk).
 */
export function getProjectGraph(projectRoot: string = ".", log?: (msg: string) => void): RepoGraph {
	const root = resolve(projectRoot);
	return scanProject(root, log);
}

// ── Scanner ──────────────────────────────────────────────────────────────────

/**
 * Remove all symbols, edges, and file-level mappings for a given file from the graph.
 */
/**
 * Remove only the edges for a single file (not symbols).
 * Used during incremental edge rebuild to clear old edges before
 * rebuilding only what changed.
 */
function removeEdgesForFile(graph: RepoGraph, relPath: string): void {
	const symIds = new Set(graph.fileSymbols.get(relPath) ?? []);

	// Remove outgoing edges from this file's symbols
	for (const id of symIds) {
		graph.outgoing.delete(id);
	}
	// Remove incoming edges to this file's symbols from other files
	for (const id of symIds) {
		graph.incoming.delete(id);
	}
	// Remove file-level import/call data for this file
	graph.fileImports.delete(relPath);
	graph.fileCalls.delete(relPath);
	graph.fileImportBindings.delete(relPath);

	// 使用反向边索引清理跨文件引用：O(K) 而非 O(E)
	for (const targetId of symIds) {
		const sourceIds = graph.targetToSources.get(targetId);
		if (!sourceIds) continue;
		for (const sourceId of sourceIds) {
			// 从 source 的 outgoing 中移除指向 targetId 的边
			const edges = graph.outgoing.get(sourceId);
			if (edges) {
				const filtered = edges.filter((e) => e.target !== targetId);
				if (filtered.length > 0) {
					graph.outgoing.set(sourceId, filtered);
				} else {
					graph.outgoing.delete(sourceId);
				}
			}
			// 从 source 的 incoming 中移除来自 targetId 的边（targetId 作为 source 的边）
			// 注意：incoming[targetId] 已在上面删除，这里清理 incoming[sourceId] 中 source 为 targetId 的边
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

function removeFileData(graph: RepoGraph, relPath: string): void {
	const symIds = graph.fileSymbols.get(relPath) || [];
	const symIdSet = new Set(symIds);

	// 在删除符号前先收集名称，用于清理 nameIndex
	const symNames: string[] = [];
	for (const id of symIds) {
		const sym = graph.symbols.get(id);
		if (sym) symNames.push(sym.name);
	}

	for (const id of symIds) {
		graph.symbols.delete(id);
		graph.outgoing.delete(id);
		graph.incoming.delete(id);
	}
	graph.fileSymbols.delete(relPath);
	graph.fileImports.delete(relPath);
	graph.fileCalls.delete(relPath);
	graph.fileImportBindings.delete(relPath);

	// 使用反向边索引清理跨文件引用：O(K) 而非 O(E)
	for (const targetId of symIdSet) {
		const sourceIds = graph.targetToSources.get(targetId);
		if (!sourceIds) continue;
		for (const sourceId of sourceIds) {
			const edges = graph.outgoing.get(sourceId);
			if (edges) {
				const filtered = edges.filter((e) => e.target !== targetId);
				if (filtered.length > 0) {
					graph.outgoing.set(sourceId, filtered);
				} else {
					graph.outgoing.delete(sourceId);
				}
			}
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

	// 从 nameIndex 中移除该文件的符号
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

		const symbols = adapter.extractSymbols(tree, lang, relPath);
		const imports = adapter.extractImports(tree, lang);
		const calls = adapter.extractCalls(tree, lang);
		const jsImportBindings = adapter.extractJsTsImportBindings(tree, lang);

		return { mtime, symbols, imports, calls, jsImportBindings };
	} catch (err) {
		// Log parse failures to aid debugging (fixes #133)
		if (err instanceof Error && err.message.includes('File too large')) {
			// Expected for large files — skip silently
			return null;
		}
		console.warn(`[pi-shazam] parseFile: failed to parse ${relPath}: ${err}`);
		return null;
	}
}

/**
 * Build edges for a single file using its cached parse data and the current graph state.
 */
function buildEdgesForFile(graph: RepoGraph, root: string, relPath: string, entry: FileCacheEntry): void {
	const thisFileSymIds = graph.fileSymbols.get(relPath) || [];

	// Import edges
	if (entry.imports.length > 0) {
		graph.fileImports.set(
			relPath,
			entry.imports.map(([m]) => m),
		);
		for (const [importedModule] of entry.imports) {
			const resolvedImport = resolveImport(importedModule, relPath, root, graph);
			const targetFileSyms = graph.fileSymbols.get(resolvedImport) || [];
			for (const srcId of thisFileSymIds) {
				for (const tgtId of targetFileSyms) {
					addEdge(graph, createEdge(srcId, tgtId, 0.3, "import", 0.5));
				}
			}
		}
	}

	// Call edges
	if (entry.calls.length > 0) {
		graph.fileCalls.set(relPath, entry.calls);
		for (const [calledName, callLine] of entry.calls) {
			const callerSyms = findCallerSymbols(thisFileSymIds, graph.symbols, callLine);
			const calleeSyms = findCalleeSymbols(calledName, graph.symbols);
			for (const caller of callerSyms) {
				for (const callee of calleeSyms) {
					if (caller.id !== callee.id) {
						addEdge(graph, createEdge(caller.id, callee.id, 1.0, "call", 0.9));
					}
				}
			}
		}
	}

	// JS/TS import bindings
	if (entry.jsImportBindings.length > 0) {
		graph.fileImportBindings.set(relPath, entry.jsImportBindings);
		for (const binding of entry.jsImportBindings) {
			const localSym = findSymbolByNameInFile(binding.localName, relPath, graph.symbols);
			if (!localSym) continue;
			const resolvedModule = resolveImport(binding.module, relPath, root, graph);
			const sourceSym = findSymbolByNameInFile(binding.importedName, resolvedModule, graph.symbols);
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
 * @returns The fully built RepoGraph with PageRank scores set
 */
export function scanProject(projectPath: string, log?: (msg: string) => void): RepoGraph {
	enterScan();
	try {
		return _scanProject(projectPath, log);
	} finally {
		exitScan();
	}
}

function _scanProject(projectPath: string, log?: (msg: string) => void): RepoGraph {
	const root = resolve(projectPath);
	const logger = log ?? (() => {});

	const adapter = new TreeSitterAdapter(logger);
	const files = collectSourceFiles(root, MAX_FILES);
	logger(`Scanned ${files.length} source files`);

	// Check in-memory cache first (same process, fastest path)
	const isInMemory = cachedGraph !== null && cachedProjectPath === root && cachedFiles.size > 0;
	if (isInMemory) {
		return scanIncremental(root, files, adapter, logger);
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
			// All mtimes match — use cached graph directly
			logger(`Cache hit: ${diskCache.graph.symbols.size} symbols loaded from disk`);
			cachedGraph = diskCache.graph;
			cachedProjectPath = root;
			cachedFiles = reconstructFileCache(diskCache.graph, diskCache.fileMtimes);
			return cachedGraph;
		}

		// Some files changed — load cache into memory, then incremental
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
			logger(`Failed to save graph cache: ${err}`);
		}

		return updatedGraph;
	}

	// No cache — full scan
	const graph = scanFull(root, files, adapter, logger);

	// Save to persistent cache
	try {
		const saveFileMtimes = getFileMtimes(root, files);
		saveGraphCache(graph, saveFileMtimes, cachePath);
		logger(`Graph cache saved: ${graph.symbols.size} symbols`);
	} catch (err) {
		logger(`Failed to save graph cache: ${err}`);
	}

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
		const jsImportBindings = graph.fileImportBindings.get(relPath) || [];

		entries.set(relPath, { mtime, symbols, imports, calls, jsImportBindings });
	}

	return entries;
}

/**
 * Full scan: parse all files from scratch.
 */
function scanFull(root: string, files: string[], adapter: TreeSitterAdapter, logger: (msg: string) => void): RepoGraph {
	const graph = createRepoGraph();
	const newFileCache = new Map<string, FileCacheEntry>();

	// Phase 1: Parse all files and extract data
	const fileMtimes = getFileMtimes(root, files);
	for (const relPath of files) {
		const mtime = fileMtimes.get(relPath) ?? 0;
		const entry = parseFile(adapter, root, relPath, mtime);
		if (!entry) continue;

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

	// Snapshot old symbol IDs for changed files BEFORE modifying graph,
	// so edge rebuild can trace callers across non-import edges (issue #93).
	const oldSymIdsByFile = new Map<string, Set<string>>();
	for (const relPath of changedFiles) {
		const oldIds = new Set(graph.fileSymbols.get(relPath) ?? []);
		oldSymIdsByFile.set(relPath, oldIds);
	}

	// Re-parse changed files — delay removeFileData until after parse succeeds
	// to avoid the rollback path that restores symbols but not edges (#156).
	for (const relPath of changedFiles) {
		const mtime = fileMtimes.get(relPath) ?? 0;
		const entry = parseFile(adapter, root, relPath, mtime);
		if (!entry) {
			// Re-parse failed — keep old data untouched (no rollback needed)
			continue;
		}

		// Parse succeeded — remove old data and replace with new
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
	}

	// Rebuild edges only for changed files and files that depend on them.
	// Previously this cleared ALL edges and rebuilt for every file (O(N)),
	// negating the benefit of incremental scanning for large projects.
	// oldSymIdsByFile was built above before removeFileData calls.

	// Find files that import from changed files (dependents)
	const dependentFiles = new Set<string>();
	for (const relPath of changedFiles) {
		// Remove old edges for this file only
		removeEdgesForFile(graph, relPath);
		dependentFiles.add(relPath);
		// Find all files that import from this changed file
		for (const [importer, imports] of graph.fileImports) {
			if (imports.includes(relPath)) {
				dependentFiles.add(importer);
			}
		}
	}

	// Also trace cross-file call edges: files whose symbols had incoming
	// edges from the changed file's old symbols need their edges rebuilt.
	for (const [, oldIds] of oldSymIdsByFile) {
		for (const oldId of oldIds) {
			const incoming = graph.incoming.get(oldId);
			if (!incoming) continue;
			for (const edge of incoming) {
				const callerSym = graph.symbols.get(edge.source);
				if (callerSym) {
					dependentFiles.add(callerSym.file);
				}
			}
		}
	}

	// Also remove edges for deleted files (already handled by removeFileData above)

	// Rebuild edges only for changed + dependent files
	for (const relPath of dependentFiles) {
		const entry = cachedFiles.get(relPath);
		if (entry) {
			buildEdgesForFile(graph, root, relPath, entry);
		}
	}

	// Recompute PageRank
	calculatePageRank(graph);

	return graph;
}

// ── File collection ──────────────────────────────────────────────────────────

function collectSourceFiles(root: string, maxFiles: number): string[] {
	const files: string[] = [];

	function walk(dir: string) {
		if (files.length >= maxFiles) return;

		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			// Log directory read failures (fixes #133, #160)
			if (err instanceof Error && (err.message.includes('EACCES') || err.message.includes('EPERM'))) {
				console.warn(`[pi-shazam] collectSourceFiles: permission denied: ${dir}`);
			} else {
				const code = (err as NodeJS.ErrnoException)?.code ?? String(err);
				console.warn(`[pi-shazam] collectSourceFiles: unexpected error reading ${dir}: ${code}`);
			}
			return;
		}

		for (const entry of entries) {
			if (files.length >= maxFiles) return;

			const relPath = relative(root, join(dir, entry.name));

			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				if (entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) continue;
				walk(join(dir, entry.name));
			} else if (entry.isSymbolicLink()) {
				// Symlinks are silently skipped to avoid cycles and
				// duplicate processing of linked directories.
			} else if (entry.isFile()) {
				const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
				if (SOURCE_EXTS.has(ext)) {
					files.push(relPath);
				}
			}
		}
	}

	walk(root);
	return files;
}

// ── Edge helpers ─────────────────────────────────────────────────────────────

function addEdge(graph: RepoGraph, edge: Edge): void {
	const outgoing = graph.outgoing.get(edge.source) || [];
	outgoing.push(edge);
	graph.outgoing.set(edge.source, outgoing);

	const incoming = graph.incoming.get(edge.target) || [];
	incoming.push(edge);
	graph.incoming.set(edge.target, incoming);

	// 维护反向边索引
	const sources = graph.targetToSources.get(edge.target);
	if (sources) {
		sources.add(edge.source);
	} else {
		graph.targetToSources.set(edge.target, new Set([edge.source]));
	}
}

// ── Import resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a relative import path to a file path that matches the fileSymbols keys.
 * Handles extensionless imports (e.g., "./foo" → "./foo.ts" or "./foo/index.ts").
 * Accepts projectRoot for absolute-path disk validation (fixes #102).
 */
function resolveImport(importPath: string, fromFile: string, root: string, graph?: RepoGraph): string {
	if (importPath.startsWith(".")) {
		const fromDir = dirname(fromFile);
		let resolved = join(fromDir, importPath);

		const candidates = [
			resolved,
			`${resolved}.ts`,
			`${resolved}.tsx`,
			`${resolved}.js`,
			`${resolved}.jsx`,
			`${resolved}.mjs`,
			`${resolved}.cjs`,
			`${resolved}.mts`,
			`${resolved}.cts`,
			`${resolved}/index.ts`,
			`${resolved}/index.tsx`,
			`${resolved}/index.js`,
		];

		if (graph) {
			for (const c of candidates) {
				if (graph.fileSymbols.has(c)) return c;
			}
		}

		// Disk validation using absolute paths (root-aware, fixes #102).
		for (const c of candidates) {
			if (existsSync(join(root, c))) {
				return c;
			}
		}
		// When no candidate exists on disk, return the first candidate.
		return candidates[0]!;
	}

	return importPath;
}

// ── Symbol lookup helpers ────────────────────────────────────────────────────

function findCallerSymbols(fileSymIds: string[], symbols: Map<string, Symbol>, callLine: number): Symbol[] {
	// Find symbols in the file that contain this call line within their range
	const candidates: Symbol[] = [];
	for (const id of fileSymIds) {
		const sym = symbols.get(id);
		if (!sym) continue;
		if (sym.line <= callLine && callLine <= sym.endLine) {
			candidates.push(sym);
		}
	}
	// Return the most specific (narrowest range) match first
	candidates.sort((a, b) => {
		const aRange = a.endLine - a.line;
		const bRange = b.endLine - b.line;
		return aRange - bRange || a.line - b.line;
	});
	// Return the most specific one
	return candidates.length > 0 ? [candidates[0]!] : [];
}

function findCalleeSymbols(name: string, symbols: Map<string, Symbol>): Symbol[] {
	// 使用 nameIndex 做 O(1) 查找，兼容传入无索引 graph 的场景
	const graph = symbols as unknown as RepoGraph;
	const index = graph.nameIndex;
	if (index && index.size > 0) {
		return index.get(name) ?? [];
	}
	// 回退到 O(N) 扫描（反序列化后索引尚未构建时）
	const results: Symbol[] = [];
	for (const sym of symbols.values()) {
		if (sym.name === name) {
			results.push(sym);
		}
	}
	return results;
}

function findSymbolByNameInFile(name: string, file: string, symbols: Map<string, Symbol>): Symbol | undefined {
	const graph = symbols as unknown as RepoGraph;
	const index = graph.nameIndex;
	if (index && index.size > 0) {
		const candidates = index.get(name);
		if (candidates) {
			for (const sym of candidates) {
				if (sym.file === file) return sym;
			}
		}
		return undefined;
	}
	// 回退到 O(N) 扫描
	for (const sym of symbols.values()) {
		if (sym.file === file && sym.name === name) {
			return sym;
		}
	}
	return undefined;
}

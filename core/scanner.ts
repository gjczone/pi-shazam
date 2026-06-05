/**
 * pi-shazam core/scanner — Project scanning + graph building.
 *
 * Walks project directories, parses source files with tree-sitter,
 * extracts symbols/imports/calls, and builds the full RepoGraph.
 *
 * This is the main entry point that all tools compose from.
 */

import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TreeSitterAdapter, EXT_TO_LANG } from "./treesitter.js";
import {
	createRepoGraph,
	createEdge,
} from "./graph.js";
import type { RepoGraph, Symbol, Edge } from "./graph.js";
import { calculatePageRank } from "./pagerank.js";
import { readFileAdaptive } from "./encoding.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Directories to skip during project scan */
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	".git",
	".worktrees",
	".cache",
	".pi-shazam",
	".qoder",
	"__pycache__",
	"target",       // Rust
	".venv",
	"venv",
	".tox",
	"coverage",
	".nyc_output",
]);

/** Maximum files to scan (safety limit) */
const MAX_FILES = 20_000;

/** File extensions to scan */
const SOURCE_EXTS = new Set(Object.keys(EXT_TO_LANG));

// ── Scanner ──────────────────────────────────────────────────────────────────

/**
 * Scan a project directory, parse all source files, build the dependency graph,
 * and compute PageRank scores.
 *
 * @param projectPath - Absolute or relative path to the project root
 * @param log - Optional logger
 * @returns The fully built RepoGraph with PageRank scores set
 */
export function scanProject(
	projectPath: string,
	log?: (msg: string) => void,
): RepoGraph {
	const root = resolve(projectPath);
	const logger = log ?? (() => {});
	const adapter = new TreeSitterAdapter(logger);
	const graph = createRepoGraph();

	// Collect all source files
	const files = collectSourceFiles(root, MAX_FILES);
	logger(`Scanned ${files.length} source files`);

	// Phase 1: Extract symbols from all files
	const fileSymbolMap = new Map<string, Symbol[]>();
	for (const relPath of files) {
		const absPath = join(root, relPath);
		const ext = relPath.slice(relPath.lastIndexOf(".")).toLowerCase();
		const lang = EXT_TO_LANG[ext];
		if (!lang) continue;

		try {
			const source = readFileAdaptive(absPath);
			const tree = adapter.parse(source, lang);
			if (!tree) continue;

			const symbols = adapter.extractSymbols(tree, lang, relPath);
			fileSymbolMap.set(relPath, symbols);

			for (const sym of symbols) {
				graph.symbols.set(sym.id, sym);
				const fileSyms = graph.fileSymbols.get(relPath) || [];
				fileSyms.push(sym.id);
				graph.fileSymbols.set(relPath, fileSyms);
			}
		} catch {
			// Skip unparseable files
		}
	}

	logger(`Extracted ${graph.symbols.size} symbols`);

	// Phase 2: Extract imports and calls, build edges
	for (const relPath of files) {
		const absPath = join(root, relPath);
		const ext = relPath.slice(relPath.lastIndexOf(".")).toLowerCase();
		const lang = EXT_TO_LANG[ext];
		if (!lang) continue;

		try {
			const source = readFileAdaptive(absPath);
			const tree = adapter.parse(source, lang);
			if (!tree) continue;

			// Import edges: file-level imports → link imported symbols to files
			const imports = adapter.extractImports(tree, lang);
			if (imports.length > 0) {
				graph.fileImports.set(relPath, imports.map(([m]) => m));
				// Create edges from this file's symbols to symbols in imported files
				const thisFileSyms = graph.fileSymbols.get(relPath) || [];
				for (const [importedModule] of imports) {
					const resolvedImport = resolveImport(importedModule, relPath);
					const targetFileSyms = graph.fileSymbols.get(resolvedImport) || [];
					for (const srcId of thisFileSyms) {
						for (const tgtId of targetFileSyms) {
							addEdge(graph, createEdge(srcId, tgtId, 0.3, "import", 0.5));
						}
					}
				}
			}

			// Call edges: function calls → link caller to callee
			const calls = adapter.extractCalls(tree, lang);
			if (calls.length > 0) {
				graph.fileCalls.set(relPath, calls);
				const thisFileSyms = graph.fileSymbols.get(relPath) || [];
				for (const [calledName, callLine] of calls) {
					// Find the most specific symbol in this file that could be the caller
					// (the symbol definition that contains this call line)
					const callerSyms = findCallerSymbols(
						thisFileSyms,
						graph.symbols,
						callLine,
					);

					// Find callee symbols across the entire project
					const calleeSyms = findCalleeSymbols(calledName, graph.symbols);

					for (const caller of callerSyms) {
						for (const callee of calleeSyms) {
							if (caller.id !== callee.id) {
								addEdge(
									graph,
									createEdge(caller.id, callee.id, 1.0, "call", 0.9),
								);
							}
						}
					}
				}
			}

			// JS/TS import bindings (precise symbol-level imports)
			const jsImports = adapter.extractJsTsImportBindings(tree, lang);
			if (jsImports.length > 0) {
				graph.fileImportBindings.set(relPath, jsImports);
				for (const binding of jsImports) {
					// Find the local symbol that represents this import binding
					const localSym = findSymbolByNameInFile(
						binding.localName,
						relPath,
						graph.symbols,
					);
					if (!localSym) continue;

					// Find the source symbol in the imported module
					const resolvedModule = resolveImport(binding.module, relPath);
					const sourceSym = findSymbolByNameInFile(
						binding.importedName,
						resolvedModule,
						graph.symbols,
					);
					if (sourceSym) {
						addEdge(
							graph,
							createEdge(localSym.id, sourceSym.id, 0.8, "import-binding", 1.0),
						);
					}
				}
			}
		} catch {
			// Skip unparseable files
		}
	}

	// Phase 3: Compute PageRank
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
		} catch {
			return;
		}

		for (const entry of entries) {
			if (files.length >= maxFiles) return;

			const relPath = relative(root, join(dir, entry.name));

			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				if (entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) continue;
				walk(join(dir, entry.name));
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
}

// ── Import resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a relative import path to a file path that matches the fileSymbols keys.
 * Handles extensionless imports (e.g., "./foo" → "./foo.ts" or "./foo/index.ts").
 */
function resolveImport(importPath: string, fromFile: string): string {
	// If it's a relative import, resolve against the fromFile's directory
	if (importPath.startsWith(".")) {
		const fromDir = fromFile.includes("/")
			? fromFile.slice(0, fromFile.lastIndexOf("/"))
			: ".";
		let resolved = join(fromDir, importPath);

		// Try common extensions and index files
		const candidates = [
			resolved,
			`${resolved}.ts`,
			`${resolved}.tsx`,
			`${resolved}.js`,
			`${resolved}.jsx`,
			`${resolved}/index.ts`,
			`${resolved}/index.tsx`,
			`${resolved}/index.js`,
		];
		return candidates[0]!;
	}

	// For bare module imports (e.g., "react", "lodash"), we can't resolve
	// them to project files, so we return the import path as-is
	return importPath;
}

// ── Symbol lookup helpers ────────────────────────────────────────────────────

function findCallerSymbols(
	fileSymIds: string[],
	symbols: Map<string, Symbol>,
	callLine: number,
): Symbol[] {
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

function findCalleeSymbols(
	name: string,
	symbols: Map<string, Symbol>,
): Symbol[] {
	const results: Symbol[] = [];
	for (const sym of symbols.values()) {
		if (sym.name === name) {
			results.push(sym);
		}
	}
	return results;
}

function findSymbolByNameInFile(
	name: string,
	file: string,
	symbols: Map<string, Symbol>,
): Symbol | undefined {
	for (const sym of symbols.values()) {
		if (sym.file === file && sym.name === name) {
			return sym;
		}
	}
	return undefined;
}

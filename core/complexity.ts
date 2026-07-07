/**
 * pi-shazam core/complexity -- Cyclomatic complexity scoring for symbols.
 *
 * Lives in `core/` because:
 *   - Architectural boundary: `core/` is the only valid home for cross-layer
 *     utilities, and complexity metrics feed both overview output and any
 *     future scoring/thresholding code.
 *   - Now uses tree-sitter AST traversal (issue #642) instead of a regex
 *     sweep, so keywords inside comments and string literals no longer
 *     inflate the count -- required for precise threshold-based alerting
 *     (#631 follow-up).
 *
 * Why AST (issue #642): the old regex matched `if|else|for|while|case|catch`
 * plus `&&`, `||`, `?:` anywhere in the source slice, including comments and
 * strings. That produces false positives. The `complexity` tree-sitter query
 * (core/treesitter-queries.ts) matches real branching node types only.
 *
 * Fallback: languages without a compiled `complexity` query (e.g. dart, or
 * any parser that failed to load) fall back to the original regex sweep so a
 * symbol is never silently scored as 1. Coverage is preserved; only the
 * supported languages gain precise counts.
 *
 * else-if rule (McCabe): a plain `else` adds 0; an `else if` adds 1 (the
 * `else_clause` counts +1 and its nested `if` counts +1, matching the
 * original regex behaviour of counting both).
 */
import type { RepoGraph, Symbol } from "./graph.js";
import { readFileAdaptive } from "./encoding.js";
import { isNonSourceFile } from "./filter.js";
import { resolve, extname } from "node:path";
import { _logWarn } from "./output.js";
import { TreeSitterAdapter } from "./treesitter.js";

/**
 * Per-symbol complexity entry used by both the text and JSON formatters.
 * `score` is the raw cyclomatic count (always >= 1 per function); the
 * caller multiplies by PageRank if it wants a ranked score.
 */
export interface ComplexityEntry {
	name: string;
	file: string;
	line: number;
	score: number;
}

// Lazily-constructed tree-sitter adapter (loads grammars once per module
// instance). Source is re-read per symbol, matching the pre-#642 behaviour.
let _adapter: TreeSitterAdapter | null = null;

function getAdapter(): TreeSitterAdapter {
	if (!_adapter) _adapter = new TreeSitterAdapter();
	return _adapter;
}

/**
 * Count cyclomatic complexity within a 1-based line range using a tree-sitter
 * AST walk (issue #642).
 *
 * Decision nodes come from the `complexity` query (real branching AST nodes,
 * never comment/string tokens). A node only counts when its span lies within
 * `[startLine, endLine]`, mirroring the old line-slice behaviour (nested
 * functions inside the range are included).
 *
 * Languages without a compiled `complexity` query fall back to the regex
 * sweep (see `regexComplexity`) so coverage is preserved.
 *
 * Exposed for unit testing -- callers usually want `topByComplexity` instead.
 */
export function countCyclomaticComplexity(
	source: string,
	lang: string | undefined,
	startLine: number,
	endLine: number,
): number {
	if (lang) {
		const matches = getAdapter().complexityMatches(source, lang);
		if (matches) {
			let count = 0;
			for (const m of matches) {
				if (m.startRow < startLine || m.endRow > endLine) continue;
				if (m.kind === "else") {
					// Plain `else` adds 0; `else if` adds 1.
					if (m.hasIfChild) count++;
				} else {
					count++;
				}
			}
			// Baseline 1 so an empty function body still has a score of 1.
			return 1 + count;
		}
	}
	// Fallback: no AST query for this language -> regex sweep (coverage kept).
	return regexComplexity(source, startLine, endLine);
}

/**
 * Original regex sweep retained as a fallback for languages without a
 * compiled `complexity` query (issue #642). Counts keywords anywhere in the
 * line slice, including comments/strings -- imprecise but never drops a
 * symbol's score to 1.
 */
function regexComplexity(source: string, startLine: number, endLine: number): number {
	// 1-based inclusive slice. Clamp to the source so callers can pass
	// endLine past EOF without an off-by-one crash.
	const lines = source.split("\n");
	const start = Math.max(1, startLine) - 1;
	const end = Math.min(lines.length, Math.max(endLine, startLine));
	if (start >= end) return 1;
	const body = lines.slice(start, end).join("\n");
	// Token regex: word-boundary keywords + the three operator variants.
	const re = /\b(if|else|for|while|case|catch)\b|&&|\|\||\?(?::|=)/g;
	const matches = body.match(re);
	// Baseline 1 so an empty function body still has a score of 1.
	return 1 + (matches?.length ?? 0);
}

/**
 * Top-N symbols ranked by raw PageRank score.
 *
 * Pure projection over the cached graph -- no file I/O. Suitable for
 * cheap inclusion in `executeOverview` even on large projects.
 */
export function topByRank(graph: RepoGraph, n: number): ComplexityEntry[] {
	const all = [...graph.symbols.values()];
	all.sort((a, b) => {
		if (b.pagerank !== a.pagerank) return b.pagerank - a.pagerank;
		// Tie-break on id for deterministic test output.
		return a.id.localeCompare(b.id);
	});
	return all.slice(0, n).map((s) => ({
		name: s.name,
		file: s.file,
		line: s.line,
		score: Number(s.pagerank.toFixed(4)),
	}));
}

/**
 * Top-N symbols ranked by cyclomatic complexity score (highest first).
 *
 * Reads each symbol's source body via `readFileAdaptive`. Errors are
 * logged and the symbol is silently skipped -- a missing or oversized
 * file should never break the overview, only reduce the result set.
 *
 * Caches results keyed by `${file}:${line}:${endLine}` so a second call
 * within the same process reuses computed scores (overview runs once
 * per tool call today, but the helper is safe for repeated use).
 */
export function topByComplexity(graph: RepoGraph, projectRoot: string, n: number): ComplexityEntry[] {
	const cache = new Map<string, number>();
	const scored: ComplexityEntry[] = [];

	// Iterate every symbol. We must look at all of them (not pre-sort by
	// PageRank) because complexity dominates the ranking, not pagerank.
	for (const sym of graph.symbols.values()) {
		// Skip symbols we can't read or that don't have a meaningful range.
		if (!sym.file || sym.line <= 0 || sym.endLine <= sym.line) continue;
		if (isNonSourceFile(sym.file)) continue;

		const cacheKey = `${sym.file}:${sym.line}:${sym.endLine}`;
		let score = cache.get(cacheKey);
		if (score === undefined) {
			score = scoreSymbol(sym, projectRoot);
			cache.set(cacheKey, score);
		}
		// Skip unreadable symbols (score === 0 signals a read failure).
		if (score <= 0) continue;
		scored.push({ name: sym.name, file: sym.file, line: sym.line, score });
	}

	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.file.localeCompare(b.file) || a.line - b.line;
	});
	return scored.slice(0, n);
}

/**
 * Read the symbol's source body and return its cyclomatic score.
 * Returns 0 on any read failure so the caller can skip it cleanly.
 */
function scoreSymbol(sym: Symbol, projectRoot: string): number {
	try {
		const filePath = resolve(projectRoot, sym.file);
		const source = readFileAdaptive(filePath);
		const lang = TreeSitterAdapter.langForExtension(extname(sym.file));
		return countCyclomaticComplexity(source, lang, sym.line, sym.endLine);
	} catch (err) {
		// Logged at warn level so an operator can investigate (file too
		// large, permission denied, encoding failure). Never thrown --
		// one bad file must not break the whole overview.
		_logWarn("scoreSymbol", `failed to score ${sym.file}:${sym.line}`, err);
		return 0;
	}
}

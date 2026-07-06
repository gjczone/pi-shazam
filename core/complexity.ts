/**
 * pi-shazam core/complexity -- Cyclomatic complexity scoring for symbols.
 *
 * Lives in `core/` because:
 *   - Architectural boundary: `core/` is the only valid home for cross-layer
 *     utilities, and complexity metrics feed both overview output and any
 *     future scoring/thresholding code.
 *   - No Pi / LSP / tree-sitter runtime dependency: only a regex sweep on
 *     the source slice for the symbol's body lines.
 *
 * Why regex (issue #629): the issue spec explicitly lists the keywords
 * `if|else|for|while|case|catch` plus `&&`, `||`, `?:` (ternary). These are
 * raw token matches, not AST node types. A regex sweep:
 *   - Is exactly what the spec asks for.
 *   - Reuses the existing `readFileAdaptive` helper (UTF-8 / GBK / GB2312
 *     fallback already in place) without a new tree-sitter query type.
 *   - Runs synchronously inside `executeOverview` -- AST re-parsing each
 *     top-N symbol would push the overview into IO-heavy territory.
 *
 * Limitations (intentional, see issue #629 "Out of scope"):
 *   - Counts keywords in strings or comments too (regex is line-blind).
 *     Acceptable for an LLM "rough ranking" surface; tree-sitter AST
 *     counting would be needed for precise thresholds (not added here).
 *   - `else if` chains still count twice (one `if` + one `else`) which
 *     matches the McCabe definition.
 */
import type { RepoGraph, Symbol } from "./graph.js";
import { readFileAdaptive } from "./encoding.js";
import { isNonSourceFile } from "./filter.js";
import { resolve } from "node:path";
import { _logWarn } from "./output.js";

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

/**
 * Count cyclomatic complexity tokens within a 1-based line range.
 *
 * Token set (per issue #629 spec):
 *   - `if`, `else`, `for`, `while`, `case`, `catch` as whole words
 *   - `&&` and `||` logical operators
 *   - `?:` ternary (`?` immediately followed by `:` -- excludes `?.` optional
 *     chaining and `??` nullish coalescing)
 *
 * Exposed for unit testing -- callers usually want `topByComplexity` instead.
 */
export function countCyclomaticComplexity(source: string, startLine: number, endLine: number): number {
	// 1-based inclusive slice. Clamp to the source so callers can pass
	// endLine past EOF without an off-by-one crash.
	const lines = source.split("\n");
	const start = Math.max(1, startLine) - 1;
	const end = Math.min(lines.length, Math.max(endLine, startLine));
	if (start >= end) return 1;
	const body = lines.slice(start, end).join("\n");
	// Token regex: word-boundary keywords + the three operator variants.
	// `\?(?::|=)` matches `?:` ternary and `?=` nullish assignment but
	// not `?.` (optional chaining) or `??` (nullish coalescing).
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
		const source = readFileAdaptive(resolve(projectRoot, sym.file));
		return countCyclomaticComplexity(source, sym.line, sym.endLine);
	} catch (err) {
		// Logged at warn level so an operator can investigate (file too
		// large, permission denied, encoding failure). Never thrown --
		// one bad file must not break the whole overview.
		_logWarn("scoreSymbol", `failed to score ${sym.file}:${sym.line}`, err);
		return 0;
	}
}

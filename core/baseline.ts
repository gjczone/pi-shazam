/**
 * pi-shazam core/baseline -- In-memory session baseline for diff-aware verify.
 *
 * Captures project health at session start (LSP errors/warnings, orphan
 * symbols, graph edges) so post-edit verify output can show what changed
 * rather than just absolute numbers.
 *
 * The baseline is stored in-memory (not persisted across sessions) and
 * resets on branch switch. If LSP is not ready at session start, the
 * baseline is deferred to the first edit trigger.
 */

import type { RepoGraph } from "./graph.js";
import { getGraphEdgeCount } from "./graph.js";
import { findOrphans } from "./filter.js";

// -- Baseline data structure ---------------------------------------------------

export interface SessionBaseline {
	branch: string;
	commit: string;
	timestamp: string;
	lspErrors: number;
	lspWarnings: number;
	orphanSymbols: number;
	graphEdges: number;
	symbolCount: number;
	fileCount: number;
}

export interface BaselineDiff {
	lspErrors: number;
	lspWarnings: number;
	orphanSymbols: number;
	graphEdges: number;
	symbolCount: number;
	fileCount: number;
	newOrphans: { name: string; kind: string; file: string; line: number }[];
	removedEdges: number;
	addedEdges: number;
}

// -- Session baseline state (in-memory) ----------------------------------------

let _baseline: SessionBaseline | null = null;
let _previousOrphans: Map<string, { name: string; kind: string; file: string; line: number }> = new Map();

/**
 * Get the current session baseline.
 */
export function getBaseline(): SessionBaseline | null {
	return _baseline;
}

/**
 * Create a baseline from the current graph state and LSP data.
 */
export function createBaseline(
	graph: RepoGraph,
	lspErrors: number,
	lspWarnings: number,
	branch: string,
	commit: string,
): SessionBaseline {
	const edgeCount = getGraphEdgeCount(graph);

	const orphanResult = findOrphans(graph);
	const orphanCount = orphanResult.all.length;

	const baseline: SessionBaseline = {
		branch,
		commit,
		timestamp: new Date().toISOString(),
		lspErrors,
		lspWarnings,
		orphanSymbols: orphanCount,
		graphEdges: edgeCount,
		symbolCount: graph.symbols.size,
		fileCount: graph.fileSymbols.size,
	};

	_baseline = baseline;

	// Cache current orphan set for future diff
	_previousOrphans = new Map();
	for (const orphan of orphanResult.all) {
		_previousOrphans.set(`${orphan.name}::${orphan.file}::${orphan.kind}::${orphan.line}`, orphan);
	}

	return baseline;
}

/**
 * Compute a diff between the current graph and the session baseline.
 * Returns null if no baseline exists.
 */
export function diffFromBaseline(graph: RepoGraph, lspErrors: number, lspWarnings: number): BaselineDiff | null {
	if (!_baseline) return null;

	const edgeCount = getGraphEdgeCount(graph);

	const orphanResult = findOrphans(graph);
	const currentOrphans = orphanResult.all;
	const currentOrphanCount = currentOrphans.length;

	// Find new orphans (not in previous baseline)
	const newOrphans = currentOrphans.filter((o) => !_previousOrphans.has(`${o.name}::${o.file}::${o.kind}::${o.line}`));

	// Count edge changes
	const previousEdges = _baseline.graphEdges;
	const addedEdges = edgeCount > previousEdges ? edgeCount - previousEdges : 0;
	const removedEdges = edgeCount < previousEdges ? previousEdges - edgeCount : 0;

	return {
		lspErrors: lspErrors - _baseline.lspErrors,
		lspWarnings: lspWarnings - _baseline.lspWarnings,
		orphanSymbols: currentOrphanCount - _baseline.orphanSymbols,
		graphEdges: edgeCount - _baseline.graphEdges,
		symbolCount: graph.symbols.size - _baseline.symbolCount,
		fileCount: graph.fileSymbols.size - _baseline.fileCount,
		newOrphans: newOrphans.slice(0, 20),
		removedEdges,
		addedEdges,
	};
}

/**
 * Reset the session baseline (called on session shutdown).
 */
export function resetBaseline(): void {
	_baseline = null;
	_previousOrphans = new Map();
}

/**
 * Format a baseline summary section for tool output.
 */
export function formatBaselineSummary(baseline: SessionBaseline): string {
	const lines: string[] = [];
	lines.push("### Session Baseline (captured at session start)");
	lines.push("");
	lines.push(`Branch: ${baseline.branch} | Commit: ${baseline.commit.slice(0, 8)}`);
	lines.push(`LSP errors: ${baseline.lspErrors} | LSP warnings: ${baseline.lspWarnings}`);
	lines.push(`Orphans: ${baseline.orphanSymbols} | Graph edges: ${baseline.graphEdges}`);
	lines.push(`Symbols: ${baseline.symbolCount} | Files: ${baseline.fileCount}`);
	lines.push("");
	return lines.join("\n");
}

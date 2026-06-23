/**
 * pi-shazam core/pagerank -- PageRank importance scoring on RepoGraph.
 *
 * Ported from repomap/src/ranking.py (GraphAnalyzer.calculate_pagerank).
 *
 * The algorithm is pure iterative PageRank with convergence detection.
 * No external dependencies beyond the graph data model.
 */

import type { RepoGraph } from "./graph.js";

/**
 * Calculate PageRank scores for all symbols in the graph.
 * Scores are stored directly on each symbol's `.pagerank` field.
 *
 * Damping factor: 0.85 (standard PageRank)
 * Max iterations: 50
 * Convergence tolerance: 1e-6
 */
export function calculatePageRank(
	graph: RepoGraph,
	damping: number = 0.85,
	maxIter: number = 50,
	tol: number = 1e-6,
): void {
	const ids = [...graph.symbols.keys()];
	const n = ids.length;
	if (n === 0) return;

	// Initial uniform distribution
	const pr = new Map<string, number>();
	for (const id of ids) {
		pr.set(id, 1.0 / n);
	}

	// Compute outgoing weight sums
	const outW = new Map<string, number>();
	for (const id of ids) {
		const edges = graph.outgoing.get(id);
		if (!edges || edges.length === 0) {
			outW.set(id, 0);
			continue;
		}
		let sum = 0;
		for (const e of edges) {
			sum += e.weight;
		}
		outW.set(id, sum);
	}

	// Active sources: nodes with positive outgoing weight
	const activeSrcs = new Set<string>();
	for (const id of ids) {
		const w = outW.get(id) || 0;
		if (w > 0 && !isNaN(w) && isFinite(w)) {
			activeSrcs.add(id);
		}
	}

	// Build incoming index: tgt -> [(src, weight), ...]
	const inc = new Map<string, [string, number][]>();
	for (const [src, edges] of graph.outgoing) {
		if (!activeSrcs.has(src)) continue;
		for (const e of edges) {
			const arr = inc.get(e.target) || [];
			arr.push([src, e.weight]);
			inc.set(e.target, arr);
		}
	}

	const base = (1 - damping) / n;

	for (let iter = 0; iter < maxIter; iter++) {
		const newPr = new Map<string, number>();
		for (const id of ids) {
			let score = base;
			const incoming = inc.get(id);
			if (incoming) {
				for (const [src, w] of incoming) {
					const srcPr = pr.get(src) || 0;
					const srcOutW = outW.get(src) || 1;
					score += (damping * srcPr * w) / srcOutW;
				}
			}
			newPr.set(id, score);
		}

		// Dangling node redistribution: nodes with zero outgoing edges distribute
		// their accumulated score uniformly to all nodes (standard PageRank).
		let danglingSum = 0;
		for (const id of ids) {
			if ((outW.get(id) || 0) === 0) {
				danglingSum += pr.get(id) || 0;
			}
		}
		const danglingContrib = (damping * danglingSum) / n;
		for (const id of ids) {
			newPr.set(id, (newPr.get(id) || 0) + danglingContrib);
		}

		// Normalize
		let total = 0;
		for (const score of newPr.values()) {
			total += score;
		}
		total = total || 1.0;
		for (const [id, score] of newPr) {
			newPr.set(id, score / total);
		}

		// Convergence check
		let delta = 0;
		for (const id of ids) {
			const oldScore = pr.get(id) || 0;
			const newScore = newPr.get(id) || 0;
			delta = Math.max(delta, Math.abs(newScore - oldScore));
		}

		// Update pr for next iteration
		for (const [id, score] of newPr) {
			pr.set(id, score);
		}

		if (delta < tol) break;
	}

	// Store scores back on symbols
	for (const [id, score] of pr) {
		const sym = graph.symbols.get(id);
		if (sym) {
			sym.pagerank = score;
		}
	}
}

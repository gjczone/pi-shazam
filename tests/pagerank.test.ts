import { describe, it, expect } from "vitest";
import { createRepoGraph, createSymbol, createEdge } from "../core/graph.js";
import { calculatePageRank } from "../core/pagerank.js";

describe("pagerank", () => {
	it("should handle empty graph", () => {
		const graph = createRepoGraph();
		calculatePageRank(graph);
		expect(graph.symbols.size).toBe(0);
	});

	it("should assign equal scores for single node", () => {
		const graph = createRepoGraph();
		const sym = createSymbol("a", "foo", "function", "f.ts", 1);
		graph.symbols.set("a", sym);

		calculatePageRank(graph);
		expect(sym.pagerank).toBeCloseTo(1.0, 5);
	});

	it("should assign equal scores for disconnected nodes", () => {
		const graph = createRepoGraph();
		const a = createSymbol("a", "foo", "function", "f.ts", 1);
		const b = createSymbol("b", "bar", "function", "f.ts", 5);
		graph.symbols.set("a", a);
		graph.symbols.set("b", b);

		calculatePageRank(graph);
		expect(a.pagerank).toBeCloseTo(b.pagerank, 5);
		expect(a.pagerank).toBeCloseTo(0.5, 5);
	});

	it("should rank nodes with edges (linked graph)", () => {
		const graph = createRepoGraph();
		const a = createSymbol("a", "A", "function", "f.ts", 1);
		const b = createSymbol("b", "B", "function", "f.ts", 5);
		const c = createSymbol("c", "C", "function", "f.ts", 10);

		graph.symbols.set("a", a);
		graph.symbols.set("b", b);
		graph.symbols.set("c", c);

		// A -> B (call edge)
		graph.outgoing.set("a", [createEdge("a", "b", 0.5, "call")]);
		graph.incoming.set("b", [createEdge("a", "b", 0.5, "call")]);

		calculatePageRank(graph);

		// All should have non-zero scores
		expect(a.pagerank).toBeGreaterThan(0);
		expect(b.pagerank).toBeGreaterThan(0);
		expect(c.pagerank).toBeGreaterThan(0);

		// Sum should be close to 1.0
		const total = a.pagerank + b.pagerank + c.pagerank;
		expect(total).toBeCloseTo(1.0, 5);
	});

	it("should converge within max iterations", () => {
		const graph = createRepoGraph();
		for (let i = 0; i < 10; i++) {
			const sym = createSymbol(`s${i}`, `sym${i}`, "function", "f.ts", i);
			graph.symbols.set(`s${i}`, sym);
		}

		// Create a chain: s0 -> s1 -> s2 -> ... -> s9
		for (let i = 0; i < 9; i++) {
			graph.outgoing.set(`s${i}`, [createEdge(`s${i}`, `s${i + 1}`, 0.5, "call")]);
		}

		calculatePageRank(graph);

		// Verify all scores are finite and > 0
		for (const sym of graph.symbols.values()) {
			expect(isFinite(sym.pagerank)).toBe(true);
			expect(sym.pagerank).toBeGreaterThan(0);
		}
	});

	// -- Issue #577: PageRank pass merge verification ------------------------

	it("should handle dangling node (zero outgoing edges) by distributing its score", () => {
		const graph = createRepoGraph();
		const a = createSymbol("a", "A", "function", "f.ts", 1);
		const b = createSymbol("b", "B", "function", "f.ts", 5);

		graph.symbols.set("a", a);
		graph.symbols.set("b", b);

		// A -> B, B has no outgoing edges (dangling)
		graph.outgoing.set("a", [createEdge("a", "b", 0.5, "call")]);
		graph.incoming.set("b", [createEdge("a", "b", 0.5, "call")]);
		// B has no outgoing edges — dangling

		calculatePageRank(graph);

		expect(a.pagerank).toBeGreaterThan(0);
		expect(b.pagerank).toBeGreaterThan(0);
		expect(isFinite(a.pagerank)).toBe(true);
		expect(isFinite(b.pagerank)).toBe(true);
		const total = a.pagerank + b.pagerank;
		expect(total).toBeCloseTo(1.0, 5);
	});

	it("should produce deterministic results on repeated calls (same graph)", () => {
		const graph1 = createRepoGraph();
		const graph2 = createRepoGraph();

		for (const g of [graph1, graph2]) {
			for (let i = 0; i < 5; i++) {
				const sym = createSymbol(`s${i}`, `sym${i}`, "function", "f.ts", i);
				g.symbols.set(`s${i}`, sym);
			}
			// Ring: s0->s1->s2->s3->s4->s0
			for (let i = 0; i < 5; i++) {
				const tgt = `s${(i + 1) % 5}`;
				const src = `s${i}`;
				g.outgoing.set(src, [createEdge(src, tgt, 0.5, "call")]);
			}
		}

		calculatePageRank(graph1);
		calculatePageRank(graph2);

		for (let i = 0; i < 5; i++) {
			const s1 = graph1.symbols.get(`s${i}`)!;
			const s2 = graph2.symbols.get(`s${i}`)!;
			expect(s1.pagerank).toBeCloseTo(s2.pagerank, 5);
		}
	});

	it("should handle all-dangling graph (no edges at all)", () => {
		const graph = createRepoGraph();
		for (let i = 0; i < 4; i++) {
			const sym = createSymbol(`s${i}`, `sym${i}`, "function", "f.ts", i);
			graph.symbols.set(`s${i}`, sym);
		}

		calculatePageRank(graph);

		for (const sym of graph.symbols.values()) {
			expect(sym.pagerank).toBeCloseTo(0.25, 5);
		}
	});
});

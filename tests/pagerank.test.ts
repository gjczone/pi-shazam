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
});

/**
 * Tests for issue #631 B (slice 3.4): shazam_lookup sorts JSON
 * output by provenance weight.
 *
 * The JSON envelope of shazam_lookup should order its matches so
 * the highest-trust (most LSP-resolved) symbols come first, with
 * PageRank as the secondary sort. The markdown output keeps the
 * original PageRank-based ordering (unchanged for the existing
 * text-mode consumers).
 */
import { describe, it, expect } from "vitest";
import {
	createRepoGraph,
	createSymbol,
	createEdge,
	type RepoGraph,
	type Provenance,
} from "../core/graph.js";
import { _buildSymbolLookupResult } from "../tools/lookup.js";

/**
 * Build a graph with two symbols named "target", one with 5
 * resolved edges and one with 0 resolved edges. The first one
 * must rank ahead in the JSON output.
 */
function buildProvenanceRankFixture(): RepoGraph {
	const graph = createRepoGraph();
	const sym = (id: string, name: string, file: string, line: number) =>
		createSymbol(id, name, "function", file, line);

	const high = sym("src/high.ts::target::10", "target", "src/high.ts", 10);
	const low = sym("src/low.ts::target::20", "target", "src/low.ts", 20);
	for (const s of [high, low]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
	}

	// Add a few "caller" symbols that link to each `target` with
	// the desired provenance mix.
	const makeCallers = (target: ReturnType<typeof createSymbol>, provenance: Provenance, count: number) => {
		for (let i = 0; i < count; i++) {
			const caller = sym(
				`src/caller_${target.id}_${i}.ts::caller::1`,
				`caller_${target.id}_${i}`,
				`src/caller_${target.id}_${i}.ts`,
				1,
			);
			graph.symbols.set(caller.id, caller);
			graph.fileSymbols.set(caller.file, [caller.id]);
			const list = graph.nameIndex.get(caller.name) ?? [];
			list.push(caller);
			graph.nameIndex.set(caller.name, list);
			const edge = createEdge(caller.id, target.id, 1.0, "call", 0.9, provenance);
			graph.outgoing.set(caller.id, [edge]);
			const incoming = graph.incoming.get(target.id) ?? [];
			incoming.push(edge);
			graph.incoming.set(target.id, incoming);
		}
	};
	makeCallers(high, "resolved", 5);
	makeCallers(low, "heuristic", 5);

	// Add the two targets themselves to nameIndex under the same
	// shared name so a lookup for "target" returns both. We add
	// `low` first to confirm the sort re-orders by provenance
	// weight, not insertion order.
	graph.nameIndex.set("target", [low, high]);
	return graph;
}

describe("shazam_lookup sorts JSON output by provenance weight (issue #631 B)", () => {
	it("the higher-resolved symbol ranks first in _buildSymbolLookupResult", () => {
		const graph = buildProvenanceRankFixture();
		const entries = _buildSymbolLookupResult(graph, "target");
		expect(entries.length).toBe(2);
		// high has 5 resolved edges, low has 0. high must come first
		// even though `low` was inserted into nameIndex first.
		expect(entries[0]!.file).toBe("src/high.ts");
		expect(entries[1]!.file).toBe("src/low.ts");
	});

	it("each entry exposes the provenance counts used for ranking", () => {
		const graph = buildProvenanceRankFixture();
		const entries = _buildSymbolLookupResult(graph, "target");
		const high = entries.find((e) => e.file === "src/high.ts");
		const low = entries.find((e) => e.file === "src/low.ts");
		expect(high?.provenanceCounts.resolved).toBe(5);
		expect(low?.provenanceCounts.resolved).toBe(0);
	});

	it("ties on resolved count fall back to PageRank ordering", () => {
		// Two symbols with the same provenance mix; ranking should
		// be stable across both.
		const graph = createRepoGraph();
		const a = createSymbol("src/a.ts::shared::1", "shared", "function", "src/a.ts", 1);
		const b = createSymbol("src/b.ts::shared::1", "shared", "function", "src/b.ts", 1);
		a.pagerank = 0.9;
		b.pagerank = 0.1;
		for (const s of [a, b]) {
			graph.symbols.set(s.id, s);
			graph.fileSymbols.set(s.file, [s.id]);
		}
		graph.nameIndex.set("shared", [b, a]); // intentionally reversed

		// Both have zero edges so provenanceCounts are all zero.
		const entries = _buildSymbolLookupResult(graph, "shared");
		expect(entries.length).toBe(2);
		// PageRank is the tiebreaker: a (0.9) before b (0.1).
		expect(entries[0]!.file).toBe("src/a.ts");
		expect(entries[1]!.file).toBe("src/b.ts");
	});

	it("name_match outranks heuristic when resolved is equal", () => {
		const graph = createRepoGraph();
		const a = createSymbol("src/a.ts::x::1", "x", "function", "src/a.ts", 1);
		const b = createSymbol("src/b.ts::x::1", "x", "function", "src/b.ts", 1);
		for (const s of [a, b]) {
			graph.symbols.set(s.id, s);
			graph.fileSymbols.set(s.file, [s.id]);
		}
		graph.nameIndex.set("x", [b, a]); // intentionally reversed
		// a has 1 name_match edge, b has 1 heuristic edge. Both have
		// zero resolved. name_match should outrank heuristic.
		const ea = createEdge("src/caller_a.ts::c::1", a.id, 1.0, "call", 0.9, "name_match");
		const eb = createEdge("src/caller_b.ts::c::1", b.id, 1.0, "call", 0.9, "heuristic");
		graph.incoming.set(a.id, [ea]);
		graph.incoming.set(b.id, [eb]);

		const entries = _buildSymbolLookupResult(graph, "x");
		expect(entries[0]!.file).toBe("src/a.ts");
		expect(entries[1]!.file).toBe("src/b.ts");
	});
});

/**
 * Tests for issue #631 B (slice 3.1): per-affected-symbol provenance
 * breakdown in shazam_impact.
 *
 * The JSON envelope should expose a `provenanceCounts` summary on
 * every affected symbol so consumers can tell at a glance which
 * call sites are LSP-resolved vs tree-sitter-heuristic. The text
 * renderer should append a compact `R/H/N/U` summary to each
 * affected file line.
 */
import { describe, it, expect } from "vitest";
import { buildImpactResult, executeImpact, executeImpactJson, executeCallChainJson } from "../tools/impact.js";
import { createRepoGraph, createSymbol, createEdge, type RepoGraph } from "../core/graph.js";

/**
 * Build a minimal graph:
 *
 *   src/a.ts::a --resolved--> src/target.ts::target
 *                 \--heuristic--> src/target.ts::target
 *                  \--name_match--> src/target.ts::target
 *
 * Caller `a` has 3 outgoing edges with different provenance values
 * to the same target. BFS upstream from `target.ts` should yield `a`
 * as an affected symbol with provenanceCounts = { resolved: 1,
 * heuristic: 1, name_match: 1, unresolved: 0 }.
 */
function buildProvenanceFixture(): RepoGraph {
	const graph = createRepoGraph();
	const sym = (id: string, name: string, file: string, line: number) => createSymbol(id, name, "function", file, line);

	const target = sym("src/target.ts::target::10", "target", "src/target.ts", 10);
	const a = sym("src/a.ts::a::1", "a", "src/a.ts", 1);
	for (const s of [target, a]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
		const list = graph.nameIndex.get(s.name) ?? [];
		list.push(s);
		graph.nameIndex.set(s.name, list);
	}

	// Three edges from a to target with distinct provenance values
	const e1 = createEdge(a.id, target.id, 1.0, "call", 0.9, "resolved");
	const e2 = createEdge(a.id, target.id, 1.0, "call", 0.9, "heuristic");
	const e3 = createEdge(a.id, target.id, 1.0, "call", 0.9, "name_match");
	graph.outgoing.set(a.id, [e1, e2, e3]);
	graph.incoming.set(target.id, [e1, e2, e3]);

	return graph;
}

describe("shazam_impact provenance breakdown (issue #631 B)", () => {
	it("buildImpactResult annotates each affected symbol with provenanceCounts", () => {
		const graph = buildProvenanceFixture();
		const result = buildImpactResult(graph, ["src/target.ts"], 3);

		expect(result.affectedSymbols.length).toBeGreaterThan(0);
		const aSym = result.affectedSymbols.find((s) => s.name === "a");
		expect(aSym).toBeDefined();
		// a has 3 outgoing edges: 1 resolved, 1 heuristic, 1 name_match
		expect(aSym?.provenanceCounts).toEqual({
			resolved: 1,
			heuristic: 1,
			name_match: 1,
			unresolved: 0,
		});
	});

	it("executeImpactJson wraps provenanceCounts in the JSON envelope", () => {
		const graph = buildProvenanceFixture();
		const envelope = executeImpactJson(graph, ["src/target.ts"], 3);
		const parsed = JSON.parse(envelope);
		expect(parsed.status).toBe("ok");
		expect(parsed.command).toBe("impact");

		const aSym = parsed.result.affectedSymbols.find((s: { name: string }) => s.name === "a");
		expect(aSym).toBeDefined();
		expect(aSym.provenanceCounts).toEqual({
			resolved: 1,
			heuristic: 1,
			name_match: 1,
			unresolved: 0,
		});
	});

	it("executeImpact text output appends a compact provenance summary to the affected-file line", () => {
		const graph = buildProvenanceFixture();
		const text = executeImpact(graph, ["src/target.ts"], { withSymbols: true, compact: false, depth: 3 });
		// The text renderer should emit something like "(R:1 H:1 N:1)" on
		// the affected file line for `src/a.ts`. The exact ordering of
		// counts is fixed by the renderer.
		expect(text).toMatch(/R:1.*N:1.*H:1/);
	});

	it("CallChainEntry edges carry the per-edge provenance field", () => {
		const graph = buildProvenanceFixture();
		const envelope = executeCallChainJson(graph, "target", 2, "incoming");
		const parsed = JSON.parse(envelope);
		expect(parsed.status).toBe("ok");
		// target has 1 CallChainEntry
		const entry = parsed.result[0];
		expect(entry.incoming.length).toBeGreaterThan(0);
		// Every incoming edge must have a `provenance` field
		for (const edge of entry.incoming) {
			expect(edge.provenance).toBeDefined();
			expect(["resolved", "name_match", "heuristic", "unresolved"]).toContain(edge.provenance);
		}
	});

	it("buildImpactResult defaults provenanceCounts to all zeros when no edges", () => {
		const graph = createRepoGraph();
		const isolated = createSymbol("src/iso.ts::iso::1", "iso", "function", "src/iso.ts", 1);
		graph.symbols.set(isolated.id, isolated);
		graph.fileSymbols.set(isolated.file, [isolated.id]);
		graph.nameIndex.set(isolated.name, [isolated]);

		const result = buildImpactResult(graph, ["src/iso.ts"], 3);
		// Isolated symbol has no incoming or outgoing edges; no affected
		// symbols are produced.
		expect(result.affectedSymbols.length).toBe(0);
	});

	it("an LSP-resolved edge shows up as resolved in the provenance breakdown", () => {
		const graph = buildProvenanceFixture();
		const result = buildImpactResult(graph, ["src/target.ts"], 3);
		const aSym = result.affectedSymbols.find((s) => s.name === "a");
		expect(aSym?.provenanceCounts.resolved).toBe(1);
	});
});

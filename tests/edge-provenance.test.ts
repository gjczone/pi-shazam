/**
 * Tests for issue #633: per-edge provenance field.
 *
 * Edge provenance tells the LLM whether a call/reference edge was
 * resolved by the LSP server (`resolved`), inferred from syntactic
 * structure (`heuristic`), or matched by name only (`name_match`).
 *
 * Minimum-scope verification:
 *  - `createEdge` defaults provenance to `"heuristic"`.
 *  - Caller can override to `"resolved"` or `"name_match"`.
 *  - `serializeEdge` / `deserializeGraphV2` round-trip the field.
 *  - Edges built without provenance (e.g. plain object literals) load
 *    with the safe default `"heuristic"` -- backwards compatible.
 *  - `getFlatReferences` (the surface used by `shazam_impact --flat`)
 *    exposes the provenance field.
 */
import { describe, it, expect } from "vitest";
import {
	createRepoGraph,
	createSymbol,
	createEdge,
	serializeEdge,
	serializeGraphV2,
	deserializeGraphV2,
	DEFAULT_PROVENANCE,
	type RepoGraph,
	type Edge,
} from "../core/graph.js";

/** Build a fresh, empty graph with two symbols linked by one edge. */
function buildEdgeFixture(provenance?: Edge["provenance"]): { graph: RepoGraph; edge: Edge } {
	const graph = createRepoGraph();
	const source = createSymbol("src/a.ts::foo::1", "foo", "function", "src/a.ts", 1);
	const target = createSymbol("src/b.ts::bar::5", "bar", "function", "src/b.ts", 5);
	for (const s of [source, target]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
		const list = graph.nameIndex.get(s.name) ?? [];
		list.push(s);
		graph.nameIndex.set(s.name, list);
	}
	const edge = createEdge(source.id, target.id, 1.0, "call", 0.9, provenance);
	graph.outgoing.set(source.id, [edge]);
	graph.incoming.set(target.id, [edge]);
	return { graph, edge };
}

describe("Edge.provenance default", () => {
	it("DEFAULT_PROVENANCE is 'heuristic'", () => {
		expect(DEFAULT_PROVENANCE).toBe("heuristic");
	});

	it("createEdge without provenance argument defaults to 'heuristic'", () => {
		const edge = createEdge("a", "b", 1.0, "call");
		expect(edge.provenance).toBe("heuristic");
	});

	it("createEdge with explicit provenance preserves it", () => {
		const resolved = createEdge("a", "b", 1.0, "call", 0.9, "resolved");
		expect(resolved.provenance).toBe("resolved");

		const nameMatch = createEdge("a", "b", 1.0, "call", 0.9, "name_match");
		expect(nameMatch.provenance).toBe("name_match");
	});

	it("provenance is optional on the Edge interface", () => {
		// Compile-time check: an Edge object literal without provenance
		// must still satisfy the interface.
		const edge: Edge = { source: "a", target: "b", weight: 1.0, kind: "call", confidence: 0.9 };
		expect(edge.provenance).toBeUndefined();
	});
});

describe("serialize / deserialize round-trip", () => {
	it("preserves provenance when written to and read from a v3 cache", () => {
		const { graph, edge } = buildEdgeFixture("resolved");
		const serialized = serializeGraphV2(graph, new Map());
		const deserialized = deserializeGraphV2(serialized);

		const roundTripped = deserialized.outgoing.get(edge.source)?.[0];
		expect(roundTripped).toBeDefined();
		expect(roundTripped?.provenance).toBe("resolved");
	});

	it("defaults missing provenance to 'heuristic' on load (backwards compat)", () => {
		// Simulate a v2 cache that was written before provenance existed.
		const { graph } = buildEdgeFixture(); // no provenance override
		const serialized = serializeGraphV2(graph, new Map());

		// Strip the provenance field to mimic a pre-#633 cache file.
		for (const e of serialized.edges) {
			delete e.provenance;
		}

		const deserialized = deserializeGraphV2(serialized);
		const edges = [...deserialized.outgoing.values()][0];
		expect(edges).toBeDefined();
		expect(edges[0].provenance).toBe("heuristic");
	});

	it("serializeEdge defaults missing provenance to 'heuristic'", () => {
		// An in-memory edge constructed without provenance should still
		// serialize cleanly -- the cache should not have undefined values.
		const edge: Edge = { source: "a", target: "b", weight: 1.0, kind: "call", confidence: 0.9 };
		const serialized = serializeEdge(edge);
		expect(serialized.provenance).toBe("heuristic");
	});
});

describe("scanner integration: all edges default to 'heuristic'", () => {
	it("all edges from a real scan carry the heuristic default", async () => {
		// Dynamically import to avoid pulling the LSP stack into cold tests.
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(".");

		// Sample edges across the graph -- if even one is missing
		// provenance, that's a regression in the scanner pipeline.
		let sampled = 0;
		let missingProvenance = 0;
		for (const edgeList of graph.outgoing.values()) {
			for (const edge of edgeList) {
				sampled++;
				if (edge.provenance === undefined) missingProvenance++;
			}
		}
		expect(sampled).toBeGreaterThan(0);
		expect(missingProvenance).toBe(0);
	});
});

describe("FlatReferences surface provenance", () => {
	it("getFlatReferences includes the provenance field per reference", async () => {
		// Use a hand-built graph to keep the test deterministic.
		const { graph } = buildEdgeFixture("resolved");
		const { getFlatReferences } = await import("../tools/impact.js");
		const { refs } = getFlatReferences(graph, "bar", "incoming");
		expect(refs).toHaveLength(1);
		expect(refs[0].provenance).toBe("resolved");
	});

	it("heuristic edges surface as 'heuristic' in flat references", async () => {
		const { graph } = buildEdgeFixture(); // default = heuristic
		const { getFlatReferences } = await import("../tools/impact.js");
		const { refs } = getFlatReferences(graph, "bar", "incoming");
		expect(refs[0].provenance).toBe("heuristic");
	});
});

describe("upgradeEdgesToResolved (LSP-driven provenance promotion, #633)", () => {
	// Minimal Location shape that `uriToPath` can decode. We use a
	// file:// URI pointing at the project root so the decoded path
	// matches the source symbol's `file` field on POSIX.
	const projectRootUri = `file://${process.cwd()}`;

	function buildMultiEdgeFixture(): {
		graph: RepoGraph;
		targetId: string;
		// IDs of the three incoming edges so tests can assert per-edge.
		edgeInFoo: string;
		edgeInBar: string;
		edgeInBaz: string;
	} {
		const graph = createRepoGraph();
		const target = createSymbol("src/t.ts::target::10", "target", "function", "src/t.ts", 10);
		graph.symbols.set(target.id, target);
		graph.fileSymbols.set(target.file, [target.id]);
		graph.nameIndex.set(target.name, [target]);

		// Three callers in different files. The middle one ("bar") spans
		// lines 20..25 so a Location at line 22 should hit it.
		const foo = createSymbol("src/foo.ts::foo::5", "foo", "function", "src/foo.ts", 5);
		const bar = createSymbol("src/bar.ts::bar::20", "bar", "function", "src/bar.ts", 20);
		const baz = createSymbol("src/baz.ts::baz::1", "baz", "function", "src/baz.ts", 1);
		for (const s of [foo, bar, baz]) {
			graph.symbols.set(s.id, s);
			graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
		}

		// Set endLine explicitly so the range check in upgrade has bite.
		foo.endLine = 6;
		bar.endLine = 25;
		baz.endLine = 2;

		const edgeInFoo = createEdge(foo.id, target.id, 1.0, "call");
		const edgeInBar = createEdge(bar.id, target.id, 1.0, "call");
		const edgeInBaz = createEdge(baz.id, target.id, 1.0, "call");

		graph.outgoing.set(foo.id, [edgeInFoo]);
		graph.outgoing.set(bar.id, [edgeInBar]);
		graph.outgoing.set(baz.id, [edgeInBaz]);
		const incoming = graph.incoming.get(target.id) ?? [];
		incoming.push(edgeInFoo, edgeInBar, edgeInBaz);
		graph.incoming.set(target.id, incoming);

		return {
			graph,
			targetId: target.id,
			edgeInFoo: edgeInFoo.source,
			edgeInBar: edgeInBar.source,
			edgeInBaz: edgeInBaz.source,
		};
	}

	it("upgrades an incoming edge when LSP confirms a reference at its source line", async () => {
		const { upgradeEdgesToResolved } = await import("../tools/lsp_enrich.js");
		const { graph, targetId } = buildMultiEdgeFixture();

		// LSP confirms foo.ts:5 (within foo's 5..6 range) calls target.
		const refs = [
			{
				uri: `${projectRootUri}/src/foo.ts`,
				range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } },
			},
		];
		const result = upgradeEdgesToResolved(graph, refs, targetId, process.cwd());

		expect(result.upgraded).toBe(1);
		expect(result.attempted).toBe(3);

		// The foo->target edge is now resolved; bar/baz stay heuristic.
		const incoming = graph.incoming.get(targetId)!;
		const bySource = new Map(incoming.map((e) => [e.source, e]));
		expect(bySource.get("src/foo.ts::foo::5")?.provenance).toBe("resolved");
		expect(bySource.get("src/bar.ts::bar::20")?.provenance).toBe("heuristic");
		expect(bySource.get("src/baz.ts::baz::1")?.provenance).toBe("heuristic");
	});

	it("matches references anywhere within the source symbol's [line, endLine] range", async () => {
		const { upgradeEdgesToResolved } = await import("../tools/lsp_enrich.js");
		const { graph, targetId } = buildMultiEdgeFixture();

		// bar spans 20..25. LSP at line 22 (1-based) should match.
		const refs = [
			{
				uri: `${projectRootUri}/src/bar.ts`,
				range: { start: { line: 21, character: 0 }, end: { line: 21, character: 4 } },
			},
		];
		const result = upgradeEdgesToResolved(graph, refs, targetId, process.cwd());
		expect(result.upgraded).toBe(1);
		expect(graph.incoming.get(targetId)!.find((e) => e.source === "src/bar.ts::bar::20")?.provenance).toBe("resolved");
	});

	it("does not touch edges already at 'resolved' or 'name_match'", async () => {
		const { upgradeEdgesToResolved } = await import("../tools/lsp_enrich.js");
		const { graph, targetId } = buildMultiEdgeFixture();

		// Pre-promote foo to "name_match".
		const incoming = graph.incoming.get(targetId)!;
		const fooEdge = incoming.find((e) => e.source === "src/foo.ts::foo::5")!;
		fooEdge.provenance = "name_match";

		const refs = [
			{
				uri: `${projectRootUri}/src/foo.ts`,
				range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
			},
		];
		const result = upgradeEdgesToResolved(graph, refs, targetId, process.cwd());

		// foo skipped (already at higher trust). bar/baz attempted but
		// their source files don't match the LSP reference path, so
		// nothing is upgraded.
		expect(result.attempted).toBe(2);
		expect(result.upgraded).toBe(0);
		expect(fooEdge.provenance).toBe("name_match"); // unchanged
	});

	it("returns zero upgrades when no references match", async () => {
		const { upgradeEdgesToResolved } = await import("../tools/lsp_enrich.js");
		const { graph, targetId } = buildMultiEdgeFixture();

		// Reference in a file no edge originates from.
		const refs = [
			{
				uri: `${projectRootUri}/src/somewhere-else.ts`,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			},
		];
		const result = upgradeEdgesToResolved(graph, refs, targetId, process.cwd());
		expect(result.upgraded).toBe(0);
		expect(result.attempted).toBe(3); // all edges tried
	});

	it("returns zero counts when the target has no incoming edges", async () => {
		const { upgradeEdgesToResolved } = await import("../tools/lsp_enrich.js");
		const graph = createRepoGraph();
		const lone = createSymbol("src/lone.ts::lone::1", "lone", "function", "src/lone.ts", 1);
		graph.symbols.set(lone.id, lone);

		const refs = [
			{
				uri: `${projectRootUri}/src/x.ts`,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			},
		];
		const result = upgradeEdgesToResolved(graph, refs, lone.id, process.cwd());
		expect(result.upgraded).toBe(0);
		expect(result.attempted).toBe(0);
	});

	it("mutates the edge object in place (visible via outgoing index too)", async () => {
		const { upgradeEdgesToResolved } = await import("../tools/lsp_enrich.js");
		const { graph, targetId, edgeInFoo } = buildMultiEdgeFixture();

		const refs = [
			{
				uri: `${projectRootUri}/src/foo.ts`,
				range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
			},
		];
		upgradeEdgesToResolved(graph, refs, targetId, process.cwd());

		// The same Edge object lives in graph.outgoing and graph.incoming;
		// both must reflect the upgrade because callers may iterate either.
		const outgoingEdge = graph.outgoing.get(edgeInFoo)?.[0];
		expect(outgoingEdge?.provenance).toBe("resolved");
	});
});

/**
 * Tests for shazam_lookup provenance visibility (#643).
 *
 * The lookup JSON envelope should expose the per-edge provenance
 * classification (resolved / name_match / heuristic / unresolved)
 * so consumers can tell at a glance which call sites are
 * LSP-confirmed vs tree-sitter-heuristic.
 */
import { describe, it, expect } from "vitest";
import { _buildSymbolLookupResult } from "../tools/lookup.js";
import type { RepoGraph, Symbol } from "../core/graph.js";

function emptyGraph(): RepoGraph {
	return {
		symbols: new Map(),
		fileSymbols: new Map(),
		nameIndex: new Map(),
		incoming: new Map(),
		outgoing: new Map(),
		fileImports: new Map(),
		fileCalls: new Map(),
		fileRefs: new Map(),
		fileTypeRefs: new Map(),
		fileImportBindings: new Map(),
		targetToSources: new Map(),
	};
}

function makeSymbol(
	graph: RepoGraph,
	opts: { id: string; name: string; file: string; line: number; kind?: string },
): Symbol {
	return {
		id: opts.id,
		name: opts.name,
		kind: opts.kind ?? "function",
		file: opts.file,
		line: opts.line,
		endLine: opts.line + 5,
		col: 1,
		visibility: "exported",
		signature: "function " + opts.name,
		pagerank: 0.5,
		docstring: undefined,
	};
}

describe("shazam_lookup provenance visibility (#643)", () => {
	it("exposes incomingEdges and outgoingEdges arrays on each match", () => {
		const graph = emptyGraph();
		const target = makeSymbol(graph, { id: "foo:src/a.ts:1:1", name: "foo", file: "src/a.ts", line: 1 });
		const caller = makeSymbol(graph, { id: "bar:src/b.ts:1:1", name: "bar", file: "src/b.ts", line: 1 });
		graph.symbols.set(target.id, target);
		graph.symbols.set(caller.id, caller);
		graph.nameIndex.set("foo", [target]);
		graph.incoming.set(target.id, [
			{ source: caller.id, target: target.id, weight: 1, kind: "calls", confidence: 1, provenance: "resolved" },
		]);
		graph.outgoing.set(target.id, [
			{ source: target.id, target: caller.id, weight: 1, kind: "calls", confidence: 1, provenance: "name_match" },
		]);

		const result = _buildSymbolLookupResult(graph, "foo");
		expect(result).toHaveLength(1);
		const entry = result[0]!;
		expect(entry.incomingEdges).toHaveLength(1);
		expect(entry.incomingEdges[0]?.provenance).toBe("resolved");
		expect(entry.incomingEdges[0]?.symbolName).toBe("bar");
		expect(entry.outgoingEdges).toHaveLength(1);
		expect(entry.outgoingEdges[0]?.provenance).toBe("name_match");
		expect(entry.outgoingEdges[0]?.symbolName).toBe("bar");
	});

	it("summarizes provenance counts across both edge sets", () => {
		const graph = emptyGraph();
		const target = makeSymbol(graph, { id: "foo:src/a.ts:1:1", name: "foo", file: "src/a.ts", line: 1 });
		const a = makeSymbol(graph, { id: "a:src/x.ts:1:1", name: "a", file: "src/x.ts", line: 1 });
		const b = makeSymbol(graph, { id: "b:src/y.ts:1:1", name: "b", file: "src/y.ts", line: 1 });
		const c = makeSymbol(graph, { id: "c:src/z.ts:1:1", name: "c", file: "src/z.ts", line: 1 });
		graph.symbols.set(target.id, target);
		graph.symbols.set(a.id, a);
		graph.symbols.set(b.id, b);
		graph.symbols.set(c.id, c);
		graph.nameIndex.set("foo", [target]);
		graph.incoming.set(target.id, [
			{ source: a.id, target: target.id, weight: 1, kind: "calls", confidence: 1, provenance: "resolved" },
			{ source: b.id, target: target.id, weight: 1, kind: "calls", confidence: 1, provenance: "heuristic" },
		]);
		graph.outgoing.set(target.id, [
			{ source: target.id, target: c.id, weight: 1, kind: "calls", confidence: 1, provenance: "unresolved" },
		]);

		const result = _buildSymbolLookupResult(graph, "foo");
		expect(result[0]?.provenanceCounts).toEqual({
			resolved: 1,
			name_match: 0,
			heuristic: 1,
			unresolved: 1,
		});
	});

	it("defaults missing provenance to 'heuristic'", () => {
		const graph = emptyGraph();
		const target = makeSymbol(graph, { id: "foo:src/a.ts:1:1", name: "foo", file: "src/a.ts", line: 1 });
		const caller = makeSymbol(graph, { id: "bar:src/b.ts:1:1", name: "bar", file: "src/b.ts", line: 1 });
		graph.symbols.set(target.id, target);
		graph.symbols.set(caller.id, caller);
		graph.nameIndex.set("foo", [target]);
		// Edge WITHOUT a provenance field
		graph.incoming.set(target.id, [{ source: caller.id, target: target.id, weight: 1, kind: "calls", confidence: 1 }]);

		const result = _buildSymbolLookupResult(graph, "foo");
		expect(result[0]?.incomingEdges[0]?.provenance).toBe("heuristic");
	});

	it("returns empty edge arrays and zero counts for symbols with no edges", () => {
		const graph = emptyGraph();
		const sym = makeSymbol(graph, { id: "lonely:src/a.ts:1:1", name: "lonely", file: "src/a.ts", line: 1 });
		graph.symbols.set(sym.id, sym);
		graph.nameIndex.set("lonely", [sym]);

		const result = _buildSymbolLookupResult(graph, "lonely");
		expect(result[0]?.incomingEdges).toEqual([]);
		expect(result[0]?.outgoingEdges).toEqual([]);
		expect(result[0]?.provenanceCounts).toEqual({
			resolved: 0,
			name_match: 0,
			heuristic: 0,
			unresolved: 0,
		});
	});
});

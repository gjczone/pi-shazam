/**
 * Tests for issue #631 B (slice 3.2): mermaid call graph in
 * shazam_impact call-chain output.
 *
 * The JSON envelope for shazam_impact --symbol should include a
 * `mermaid` field on every CallChainEntry that captures the
 * incoming + outgoing call graph as a Mermaid `flowchart TD`
 * block. Edges use a `resolved | heuristic | unresolved` style
 * suffix so the consumer can see provenance at a glance.
 */
import { describe, it, expect } from "vitest";
import { _buildCallChainResult, buildMermaidCallGraph } from "../tools/impact.js";
import { createRepoGraph, createSymbol, createEdge, type RepoGraph } from "../core/graph.js";

/**
 * Build a small fixture with two callers (one resolved, one
 * heuristic) and one callee, all in distinct files:
 *
 *   src/foo.ts::foo --resolved--> src/target.ts::target
 *   src/bar.ts::bar --heuristic-> src/target.ts::target
 *   src/target.ts::target --heuristic-> src/baz.ts::baz
 */
function buildMermaidFixture(): RepoGraph {
	const graph = createRepoGraph();
	const sym = (id: string, name: string, file: string, line: number) => createSymbol(id, name, "function", file, line);

	const target = sym("src/target.ts::target::10", "target", "src/target.ts", 10);
	const foo = sym("src/foo.ts::foo::1", "foo", "src/foo.ts", 1);
	const bar = sym("src/bar.ts::bar::2", "bar", "src/bar.ts", 2);
	const baz = sym("src/baz.ts::baz::3", "baz", "src/baz.ts", 3);
	for (const s of [target, foo, bar, baz]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
		const list = graph.nameIndex.get(s.name) ?? [];
		list.push(s);
		graph.nameIndex.set(s.name, list);
	}

	// foo (resolved) and bar (heuristic) call target
	const e1 = createEdge(foo.id, target.id, 1.0, "call", 0.9, "resolved");
	const e2 = createEdge(bar.id, target.id, 1.0, "call", 0.9, "heuristic");
	// target (heuristic) calls baz
	const e3 = createEdge(target.id, baz.id, 1.0, "call", 0.9, "heuristic");
	graph.outgoing.set(foo.id, [e1]);
	graph.outgoing.set(bar.id, [e2]);
	graph.outgoing.set(target.id, [e3]);
	graph.incoming.set(target.id, [e1, e2]);
	graph.incoming.set(baz.id, [e3]);

	return graph;
}

describe("shazam_impact mermaid call graph (issue #631 B)", () => {
	it("buildMermaidCallGraph returns a flowchart TD block", () => {
		const graph = buildMermaidFixture();
		const result = _buildCallChainResult(graph, "target", 2, "both");
		const entry = result[0]!;
		const mermaid = buildMermaidCallGraph(entry);

		expect(mermaid).toBeTypeOf("string");
		expect(mermaid.length).toBeGreaterThan(0);
		// Must use the TD (top-down) layout for stable rendering
		expect(mermaid).toContain("flowchart TD");
		// Must mention every visible symbol
		expect(mermaid).toContain("foo");
		expect(mermaid).toContain("bar");
		expect(mermaid).toContain("target");
		expect(mermaid).toContain("baz");
		// Must include the resolved + heuristic edge annotations
		expect(mermaid).toContain("resolved");
		expect(mermaid).toContain("heuristic");
	});

	it("_buildCallChainResult attaches a mermaid string to each entry", () => {
		const graph = buildMermaidFixture();
		const result = _buildCallChainResult(graph, "target", 2, "both");
		expect(result.length).toBe(1);
		const entry = result[0]!;
		// The field is `mermaid` -- a non-empty string.
		expect(entry.mermaid).toBeTypeOf("string");
		expect(entry.mermaid).toContain("flowchart TD");
	});

	it("mermaid call graph truncates to MAX_MERMAID_NODES (no unbounded growth)", () => {
		// Build a hub-and-spoke graph with 100 callers all pointing to
		// one target. The renderer should not produce a 100-node graph.
		const graph = createRepoGraph();
		const target = createSymbol("src/target.ts::target::1", "target", "function", "src/target.ts", 1);
		graph.symbols.set(target.id, target);
		graph.fileSymbols.set(target.file, [target.id]);
		graph.nameIndex.set(target.name, [target]);
		for (let i = 0; i < 100; i++) {
			const caller = createSymbol(`src/c${i}.ts::c${i}::1`, `c${i}`, "function", `src/c${i}.ts`, 1);
			graph.symbols.set(caller.id, caller);
			graph.fileSymbols.set(caller.file, [caller.id]);
			const list = graph.nameIndex.get(caller.name) ?? [];
			list.push(caller);
			graph.nameIndex.set(caller.name, list);
			const edge = createEdge(caller.id, target.id, 1.0, "call", 0.9, "heuristic");
			graph.outgoing.set(caller.id, [edge]);
			const incoming = graph.incoming.get(target.id) ?? [];
			incoming.push(edge);
			graph.incoming.set(target.id, incoming);
		}

		const result = _buildCallChainResult(graph, "target", 2, "both");
		const entry = result[0]!;
		const mermaid = entry.mermaid ?? "";
		// Count the number of subgraph/edge lines -- each edge is one
		// line. The fixture is intentionally larger than the cap, so
		// the rendered graph must be strictly smaller.
		const edgeLines = mermaid.split("\n").filter((l) => l.includes("-->")).length;
		expect(edgeLines).toBeLessThan(100);
	});

	it("mermaid escapes special characters in symbol names", () => {
		const graph = createRepoGraph();
		// Symbol with a hyphen and a dot in the name -- common for
		// namespaced methods like `foo.bar` or class methods.
		const target = createSymbol("src/t.ts::t::1", "t", "function", "src/t.ts", 1);
		const weird = createSymbol("src/w.ts::weird-name::1", "weird-name", "function", "src/w.ts", 1);
		graph.symbols.set(target.id, target);
		graph.symbols.set(weird.id, weird);
		graph.fileSymbols.set(target.file, [target.id]);
		graph.fileSymbols.set(weird.file, [weird.id]);
		graph.nameIndex.set(target.name, [target]);
		graph.nameIndex.set(weird.name, [weird]);
		const edge = createEdge(weird.id, target.id, 1.0, "call", 0.9, "heuristic");
		graph.outgoing.set(weird.id, [edge]);
		graph.incoming.set(target.id, [edge]);

		const result = _buildCallChainResult(graph, "t", 2, "incoming");
		const entry = result[0]!;
		const mermaid = entry.mermaid ?? "";
		// The hyphen must not break the Mermaid parser; we either
		// quote the node or strip the hyphen.
		expect(mermaid).toMatch(/weird[-_]name|"weird-name"/);
	});
});

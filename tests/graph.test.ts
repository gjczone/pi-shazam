import { describe, it, expect } from "vitest";
import {
	createSymbol,
	createEdge,
	createRepoGraph,
	compareGraphSnapshots,
	serializeSymbol,
	} from "../core/graph.js";
import type { Symbol, Edge } from "../core/graph.js";

describe("graph", () => {
	describe("createSymbol", () => {
		it("should create a symbol with default values", () => {
			const sym = createSymbol("id1", "foo", "function", "test.ts", 10);
			expect(sym.id).toBe("id1");
			expect(sym.name).toBe("foo");
			expect(sym.kind).toBe("function");
			expect(sym.file).toBe("test.ts");
			expect(sym.line).toBe(10);
			expect(sym.visibility).toBe("public");
			expect(sym.pagerank).toBe(0);
			expect(sym.signature).toBe("");
		});

		it("should create a symbol with overrides", () => {
			const sym = createSymbol("id1", "bar", "class", "x.ts", 5, {
				visibility: "exported",
				signature: "class Bar",
				pagerank: 0.5,
			});
			expect(sym.visibility).toBe("exported");
			expect(sym.signature).toBe("class Bar");
			expect(sym.pagerank).toBe(0.5);
		});
	});

	describe("createEdge", () => {
		it("should create an edge with defaults", () => {
			const edge = createEdge("src1", "tgt1", 0.5, "call");
			expect(edge.source).toBe("src1");
			expect(edge.target).toBe("tgt1");
			expect(edge.weight).toBe(0.5);
			expect(edge.kind).toBe("call");
			expect(edge.confidence).toBe(1.0);
		});
	});

	describe("createRepoGraph", () => {
		it("should create an empty graph", () => {
			const graph = createRepoGraph();
			expect(graph.symbols.size).toBe(0);
			expect(graph.outgoing.size).toBe(0);
			expect(graph.incoming.size).toBe(0);
		});
	});

	describe("serializeSymbol", () => {
		it("should serialize a symbol to plain object", () => {
			const sym = createSymbol("id1", "foo", "function", "test.ts", 10);
			const ser = serializeSymbol(sym);
			expect(ser.id).toBe("id1");
			expect(ser.name).toBe("foo");
			expect(ser.file).toBe("test.ts");
		});
	});

	describe("compareGraphSnapshots", () => {
		it("should detect added symbols", () => {
			const currentSyms: Symbol[] = [
				createSymbol("a", "foo", "function", "f.ts", 1),
				createSymbol("b", "bar", "class", "f.ts", 5),
			];
			const result = compareGraphSnapshots(currentSyms, [], [], []);
			expect(result.summary.added).toBe(2);
			expect(result.summary.removed).toBe(0);
			expect(result.summary.modified).toBe(0);
		});

		it("should detect removed symbols", () => {
			const prevSyms = [
				serializeSymbol(createSymbol("old", "gone", "function", "f.ts", 1)),
			];
			const result = compareGraphSnapshots([], [], prevSyms, []);
			expect(result.summary.removed).toBe(1);
		});

		it("should detect no changes for identical snapshots", () => {
			const sym = createSymbol("a", "foo", "function", "f.ts", 1);
			const prev = serializeSymbol(sym);
			const result = compareGraphSnapshots([sym], [], [prev], []);
			expect(result.summary.added).toBe(0);
			expect(result.summary.removed).toBe(0);
			expect(result.summary.modified).toBe(0);
		});

		it("should detect signature changes", () => {
			const oldSym = createSymbol("a", "foo", "function", "f.ts", 1, {
				signature: "oldSig",
			});
			const newSym = createSymbol("a", "foo", "function", "f.ts", 1, {
				signature: "newSig",
			});
			const prev = serializeSymbol(oldSym);
			const result = compareGraphSnapshots([newSym], [], [prev], []);
			expect(result.summary.modified).toBe(1);
			expect(result.modifiedSymbols[0]!.signatureChanged).toBe(true);
		});
	});

});

/**
 * Tests for issue #628: ProtoBuf (V3) graph cache format.
 *
 * V3 caches the edge data in a compact columnar ProtoBuf blob
 * prefixed by a 4-byte magic header ("SHA\\3"). The V2 JSON
 * format remains readable for backward compatibility. This file
 * covers the round-trip and magic-byte detection paths.
 */
import { describe, it, expect } from "vitest";
import { createRepoGraph, createSymbol, createEdge, type RepoGraph } from "../core/graph.js";
import { serializeGraphV3, deserializeGraphV3, CACHE_V3_MAGIC } from "../core/cache.js";

/** Build a small graph fixture with all five edge maps populated. */
function buildV3Fixture(): RepoGraph {
	const graph = createRepoGraph();
	const sym = (id: string, name: string, file: string, line: number) => createSymbol(id, name, "function", file, line);

	const a = sym("src/a.ts::a::1", "a", "src/a.ts", 1);
	const b = sym("src/b.ts::b::1", "b", "src/b.ts", 1);
	const c = sym("src/c.ts::c::1", "c", "src/c.ts", 1);
	for (const s of [a, b, c]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [s.id]);
		const list = graph.nameIndex.get(s.name) ?? [];
		list.push(s);
		graph.nameIndex.set(s.name, list);
	}

	// Symbol-level edges (incoming / outgoing)
	const e1 = createEdge(a.id, b.id, 1.0, "call", 0.9, "resolved");
	const e2 = createEdge(b.id, c.id, 1.0, "call", 0.9, "heuristic");
	const e3 = createEdge(a.id, c.id, 1.0, "type", 0.5, "name_match");
	graph.outgoing.set(a.id, [e1, e3]);
	graph.outgoing.set(b.id, [e2]);
	graph.incoming.set(b.id, [e1]);
	graph.incoming.set(c.id, [e2, e3]);

	// File-level edge maps (each row is a tuple: [targetSymId, line, kind])
	graph.fileCalls.set("src/a.ts", [
		[b.id, 1, "call"],
		[c.id, 2, "call"],
	]);
	graph.fileCalls.set("src/b.ts", [[c.id, 3, "call"]]);
	graph.fileRefs.set("src/a.ts", [[c.id, 4]]);
	graph.fileTypeRefs.set("src/b.ts", [[a.id, 5]]);

	return graph;
}

describe("Cache V3 magic bytes (issue #628)", () => {
	it("exports the SHA\\3 magic header as a 4-byte Buffer", () => {
		expect(CACHE_V3_MAGIC).toBeInstanceOf(Buffer);
		expect(CACHE_V3_MAGIC.length).toBe(4);
		// "S" "H" "A" "\\3"
		expect(CACHE_V3_MAGIC[0]).toBe(0x53);
		expect(CACHE_V3_MAGIC[1]).toBe(0x48);
		expect(CACHE_V3_MAGIC[2]).toBe(0x41);
		expect(CACHE_V3_MAGIC[3]).toBe(0x03);
	});
});

describe("Cache V3 serialize / deserialize round-trip (issue #628)", () => {
	it("serializes a non-empty graph to a Buffer starting with the magic bytes", () => {
		const graph = buildV3Fixture();
		const buf = serializeGraphV3(graph);
		expect(buf).toBeInstanceOf(Buffer);
		expect(buf.length).toBeGreaterThan(4); // magic + payload
		// Magic header must be at offset 0
		expect(buf.subarray(0, 4).equals(CACHE_V3_MAGIC)).toBe(true);
	});

	it("round-trips symbol-level edges with all provenance values", () => {
		const graph = buildV3Fixture();
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);
		// Symbol-level edges survive the round-trip
		const outFromA = loaded.outgoing.get("src/a.ts::a::1") ?? [];
		expect(outFromA.length).toBe(2);
		const byTarget = new Map(outFromA.map((e) => [e.target, e]));
		const abEdge = byTarget.get("src/b.ts::b::1");
		expect(abEdge).toBeDefined();
		expect(abEdge?.kind).toBe("call");
		expect(abEdge?.provenance).toBe("resolved");
		const acEdge = byTarget.get("src/c.ts::c::1");
		expect(acEdge?.kind).toBe("type");
		expect(acEdge?.provenance).toBe("name_match");
		// Incoming edges too
		const inToC = loaded.incoming.get("src/c.ts::c::1") ?? [];
		expect(inToC.length).toBe(2);
	});

	it("round-trips file-level edge maps (fileCalls, fileRefs, fileTypeRefs)", () => {
		const graph = buildV3Fixture();
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);
		expect(loaded.fileCalls.get("src/a.ts")).toBeDefined();
		expect(loaded.fileRefs.get("src/a.ts")).toBeDefined();
		expect(loaded.fileTypeRefs.get("src/b.ts")).toBeDefined();
	});

	it("round-trips an empty graph without throwing", () => {
		const graph = createRepoGraph();
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);
		expect(loaded.symbols.size).toBe(0);
		expect(loaded.outgoing.size).toBe(0);
	});

	it("round-trips a graph with 100+ edges (stress)", () => {
		const graph = createRepoGraph();
		// Build 200 edges between 20 symbols
		for (let i = 0; i < 20; i++) {
			const s = createSymbol(`src/s${i}.ts::s${i}::1`, `s${i}`, "function", `src/s${i}.ts`, 1);
			graph.symbols.set(s.id, s);
			graph.fileSymbols.set(s.file, [s.id]);
			graph.nameIndex.set(s.name, [s]);
		}
		for (let i = 0; i < 200; i++) {
			const src = `src/s${i % 20}.ts::s${i % 20}::1`;
			const tgt = `src/s${(i + 1) % 20}.ts::s${(i + 1) % 20}::1`;
			const edge = createEdge(src, tgt, 1.0, "call", 0.9, i % 4 === 0 ? "resolved" : "heuristic");
			const list = graph.outgoing.get(src) ?? [];
			list.push(edge);
			graph.outgoing.set(src, list);
		}
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);
		// All 200 edges survive the round-trip
		let total = 0;
		for (const list of loaded.outgoing.values()) total += list.length;
		expect(total).toBe(200);
	});

	it("rejects a buffer that does not start with the magic bytes", () => {
		const bad = Buffer.from("XXXXthis is not a cache file", "utf-8");
		expect(() => deserializeGraphV3(bad)).toThrow(/magic/i);
	});

	it("rejects a buffer that is exactly the magic bytes (no payload)", () => {
		expect(() => deserializeGraphV3(CACHE_V3_MAGIC)).toThrow();
	});
});

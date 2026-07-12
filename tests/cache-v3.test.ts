/**
 * Tests for issue #628: ProtoBuf (V3) graph cache format.
 *
 * V3 caches the edge data in a compact columnar ProtoBuf blob
 * prefixed by a 4-byte magic header ("SHA\\5" since issue #647
 * follow-up D). The V2 JSON format remains readable for backward
 * compatibility. This file covers the round-trip and magic-byte
 * detection paths.
 *
 * Issue #647: V3.1 also adds a top-level string table that
 * dedupes symbol IDs across edges. V3.2 encodes `kind` as int32
 * instead of string (1 byte varint vs. 5-7 bytes per row). The
 * tests in this file assert round-trip correctness -- edges recover
 * the exact source / target after a serialize -> deserialize cycle.
 * The on-disk size benchmark (V3 < V2 * 0.6) lives in
 * `tests/benchmark-v3.test.ts`. That file is excluded from the broad
 * `npm test` run (its timing assertions are load-sensitive and flaky
 * under full-suite parallel load — issue #650) and is instead executed
 * by the dedicated `benchmark` CI job in isolation.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { createRepoGraph, createSymbol, createEdge, type RepoGraph } from "../core/graph.js";
import {
	serializeGraphV3,
	saveGraphCache,
	loadGraphCache,
	deserializeGraphV3,
	deserializeGraphV3V1,
	deserializeGraphV3V0,
	CACHE_V3_MAGIC,
	CACHE_V3_1_MAGIC,
	CACHE_V3_0_MAGIC,
} from "../core/cache.js";
import {
	encodeGraphPayload,
	decodeGraphPayload,
	encodeGraphPayloadV31,
	decodeGraphPayloadV31,
	getGraphPayloadType,
	type ProtoGraphPayload,
	type ProtoGraphPayloadV31,
} from "../core/proto-schema.js";

/**
 * Strip the V3 magic header so the ProtoBuf body can be decoded
 * directly. Used by the unit tests that assert on wire-level
 * structure (string table dedup, int kind encoding, etc.).
 */
function stripMagic(buf: Buffer): Buffer {
	return buf.subarray(CACHE_V3_MAGIC.length);
}

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
	it("exports the SHA\\5 magic header as a 4-byte Buffer (V3.2)", () => {
		expect(CACHE_V3_MAGIC).toBeInstanceOf(Buffer);
		expect(CACHE_V3_MAGIC.length).toBe(4);
		// "S" "H" "A" "\\5" (V3.2, since issue #647 follow-up D)
		expect(CACHE_V3_MAGIC[0]).toBe(0x53);
		expect(CACHE_V3_MAGIC[1]).toBe(0x48);
		expect(CACHE_V3_MAGIC[2]).toBe(0x41);
		expect(CACHE_V3_MAGIC[3]).toBe(0x05);
	});

	it("keeps the V3.0 and V3.1 magic headers as separate constants for legacy routing", () => {
		expect(CACHE_V3_0_MAGIC[3]).toBe(0x03);
		expect(CACHE_V3_1_MAGIC[3]).toBe(0x04);
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

describe("Cache V3.1 string table (issue #647)", () => {
	/**
	 * Build a graph where the same source / target IDs repeat
	 * many times -- the string table exists precisely to dedupe
	 * these. On a 20-symbol / 200-edge graph the same 20 IDs
	 * appear 20x across the source + target columns.
	 */
	function buildRepetitiveGraph(): RepoGraph {
		const graph = createRepoGraph();
		for (let i = 0; i < 20; i++) {
			const s = createSymbol(`src/s${i}.ts::s${i}::1`, `s${i}`, "function", `src/s${i}.ts`, 1);
			graph.symbols.set(s.id, s);
			graph.fileSymbols.set(s.file, [s.id]);
			graph.nameIndex.set(s.name, [s]);
		}
		for (let i = 0; i < 200; i++) {
			const src = `src/s${i % 20}.ts::s${i % 20}::1`;
			const tgt = `src/s${(i + 1) % 20}.ts::s${(i + 1) % 20}::1`;
			const edge = createEdge(src, tgt, 1.0, "call", 0.9, "heuristic");
			const list = graph.outgoing.get(src) ?? [];
			list.push(edge);
			graph.outgoing.set(src, list);
		}
		return graph;
	}

	/** Strip the magic header so we can decode the ProtoBuf body. */
	function stripMagic(buf: Buffer): Buffer {
		return buf.subarray(CACHE_V3_MAGIC.length);
	}

	it("dedupes repeated symbol IDs into a top-level string table", () => {
		const graph = buildRepetitiveGraph();
		const buf = serializeGraphV3(graph);
		const payload = decodeGraphPayload(stripMagic(buf)) as ProtoGraphPayload;

		// 20 unique IDs are referenced across 200 edges; the string
		// table should hold exactly those 20 entries (one per
		// first-occurrence order).
		expect(payload.string_table).toBeDefined();
		expect(payload.string_table!.length).toBe(20);
		// The table is keyed by first-occurrence order; the first
		// edge in `graph.outgoing` is the very first symbol (i=0),
		// so its source and target should occupy index 0 and 1.
		expect(payload.string_table![0]).toBe("src/s0.ts::s0::1");
		expect(payload.string_table![1]).toBe("src/s1.ts::s1::1");
	});

	it("emits one int32 index per edge, not one inline string", () => {
		const graph = buildRepetitiveGraph();
		const buf = serializeGraphV3(graph);
		const payload = decodeGraphPayload(stripMagic(buf)) as ProtoGraphPayload;

		// 200 edges, 200 source indices, 200 target indices.
		expect(payload.edge_source_idx!.length).toBe(200);
		expect(payload.edge_target_idx!.length).toBe(200);
		// Each index is a small int32 (fits in < 30 for 20-symbol
		// graph), so the varint-encoded bytes are short.
		for (const idx of payload.edge_source_idx!) {
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(idx).toBeLessThan(20);
		}
	});

	it("every edge round-trips to the exact source / target IDs", () => {
		const graph = buildRepetitiveGraph();
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);

		// Build (source, target) -> count map on both sides and
		// compare. Order is not guaranteed by Map iteration, so
		// we compare by multiset equality.
		const countEdges = (g: RepoGraph): Map<string, number> => {
			const m = new Map<string, number>();
			for (const [, list] of g.outgoing) {
				for (const e of list) {
					const key = `${e.source}\u0000${e.target}`;
					m.set(key, (m.get(key) ?? 0) + 1);
				}
			}
			return m;
		};
		const orig = countEdges(graph);
		const restored = countEdges(loaded);
		expect(restored.size).toBe(orig.size);
		for (const [k, v] of orig) {
			expect(restored.get(k)).toBe(v);
		}
	});

	it("incoming index is rebuilt from string-table-backed source/target", () => {
		const graph = buildRepetitiveGraph();
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);

		// Every target ID in `loaded.incoming` must be a real
		// symbol ID (string-table lookup succeeded, no garbage).
		let totalIncoming = 0;
		for (const [targetId, list] of loaded.incoming) {
			expect(graph.symbols.has(targetId)).toBe(true);
			for (const e of list) {
				expect(e.target).toBe(targetId);
				expect(graph.symbols.has(e.source)).toBe(true);
			}
			totalIncoming += list.length;
		}
		// 200 edges produce 200 incoming entries (one per edge).
		expect(totalIncoming).toBe(200);
	});

	it("handles an empty graph (zero edges -> zero-length string table)", () => {
		const graph = createRepoGraph();
		const buf = serializeGraphV3(graph);
		const payload = decodeGraphPayload(stripMagic(buf)) as ProtoGraphPayload;
		expect(payload.string_table).toBeDefined();
		expect(payload.string_table!.length).toBe(0);
		expect(payload.edge_source_idx!.length).toBe(0);
		expect(payload.edge_target_idx!.length).toBe(0);
	});

	it("verifies a corrupted cache (mismatched index lengths) throws on load", () => {
		const graph = buildRepetitiveGraph();
		const buf = serializeGraphV3(graph);
		// Decode the payload, corrupt it by truncating edge_target_idx,
		// re-encode, and confirm deserializeGraphV3 rejects it.
		const payload = decodeGraphPayload(stripMagic(buf)) as ProtoGraphPayload;
		payload.edge_target_idx = (payload.edge_target_idx ?? []).slice(0, 100);
		const corrupted = Buffer.concat([CACHE_V3_MAGIC, encodeGraphPayload(payload)]);
		expect(() => deserializeGraphV3(corrupted)).toThrow(/length mismatch/i);
	});
});

/**
 * V3.2 (issue #647 follow-up D): `EdgeColumn.kind` and
 * `FileEdgeColumn.kind` are encoded as int32 (1 byte varint) instead
 * of string. All five production kind values must round-trip exactly.
 */
describe("Cache V3.2 kind int encoding (issue #647 follow-up D)", () => {
	it("round-trips every production kind value on symbol-level edges", () => {
		const graph = createRepoGraph();
		const kinds = ["call", "type", "import", "ref", "import-binding"] as const;
		for (let i = 0; i < kinds.length; i++) {
			const src = createSymbol(`src/s${i}.ts::s${i}::1`, `s${i}`, "function", `src/s${i}.ts`, 1);
			const tgt = createSymbol(`src/t${i}.ts::t${i}::1`, `t${i}`, "function", `src/t${i}.ts`, 1);
			graph.symbols.set(src.id, src);
			graph.symbols.set(tgt.id, tgt);
			graph.outgoing.set(src.id, [createEdge(src.id, tgt.id, 1.0, kinds[i]!, 0.9, "heuristic")]);
		}
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);
		// All five kind values must come back as the original strings.
		const restoredKinds = new Set<string>();
		for (const [, list] of loaded.outgoing) {
			for (const e of list) restoredKinds.add(e.kind);
		}
		expect(restoredKinds).toEqual(new Set(kinds));
	});

	it("emits kind as int32 (numbers, not strings) on the wire", () => {
		const graph = createRepoGraph();
		const a = createSymbol("a.ts::a::1", "a", "function", "a.ts", 1);
		const b = createSymbol("b.ts::b::1", "b", "function", "b.ts", 1);
		graph.symbols.set(a.id, a);
		graph.symbols.set(b.id, b);
		// Use "import" (= 2) so the kind is non-zero -- proto3 omits
		// 0-valued fields from the wire, which would make this
		// test unable to observe the int encoding.
		graph.outgoing.set(a.id, [createEdge(a.id, b.id, 1.0, "import", 0.9, "resolved")]);
		const buf = serializeGraphV3(graph);
		const payload = decodeGraphPayload(stripMagic(buf)) as ProtoGraphPayload;
		expect(typeof payload.edges!.kind[0]).toBe("number");
		expect(payload.edges!.kind[0]).toBe(2); // "import" = 2
	});

	it("round-trips file-level kind values (call / ref / typeRef)", () => {
		const graph = createRepoGraph();
		// fileCalls (kind = "call"), fileRefs (kind = "ref"), fileTypeRefs (kind = "typeRef")
		graph.fileCalls.set("a.ts", [["b", 1, "call"]]);
		graph.fileRefs.set("a.ts", [["b", 2]]);
		graph.fileTypeRefs.set("a.ts", [["b", 3]]);
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);
		// fileCalls still carries the [symId, line, "call"] triple shape.
		expect(loaded.fileCalls.get("a.ts")).toEqual([["b", 1, "call"]]);
		expect(loaded.fileRefs.get("a.ts")).toEqual([["b", 2]]);
		expect(loaded.fileTypeRefs.get("a.ts")).toEqual([["b", 3]]);
	});
});

/**
 * Legacy V3.0 / V3.1 deserializers (issue #647 follow-up E).
 *
 * `deserializeGraphV3V1` reads a V3.1 cache (magic 0x04). The V3.1
 * and V3.2 wire formats are wire-compatible for `kind` because the
 * int32 wire type encodes the same small integer values that the V3.1
 * writer would have written as short ASCII strings ("call"=0, "type"=1,
 * "import"=2, "ref"=3, "typeRef"=4, "import-binding"=5). The V3.1
 * reader's _intToKind helper still produces the correct string for
 * these values.
 *
 * `deserializeGraphV3V0` reads a V3.0 cache (magic 0x03) where there
 * was no string table; source / target are inline on EdgeColumn. The
 * V3.0 reader is tested via magic-rejection only -- building a true
 * V3.0 wire buffer (with `kind` as a string field) would require a
 * separate V3.0-specific ProtoBuf schema, which adds complexity for
 * limited value. The V3.0 conversion path in `loadGraphCache` is
 * exercised by the end-to-end round-trip test in `graph-cache.test.ts`.
 */
describe("Cache V3.0 / V3.1 legacy deserializers (issue #647 follow-up E)", () => {
	/**
	 * Build a small graph with a non-zero kind so the kind value is
	 * actually emitted on the wire (proto3 omits 0-valued fields).
	 */
	function buildLegacyFixture(): RepoGraph {
		const graph = createRepoGraph();
		const a = createSymbol("a.ts::a::1", "a", "function", "a.ts", 1);
		const b = createSymbol("b.ts::b::1", "b", "function", "b.ts", 1);
		graph.symbols.set(a.id, a);
		graph.symbols.set(b.id, b);
		graph.fileSymbols.set(a.file, [a.id]);
		graph.fileSymbols.set(b.file, [b.id]);
		graph.nameIndex.set(a.name, [a]);
		graph.nameIndex.set(b.name, [b]);
		// "import" = 2 (non-zero), "ref" = 3 (non-zero) so the
		// kind bytes are guaranteed to be on the wire.
		graph.outgoing.set(a.id, [createEdge(a.id, b.id, 1.0, "import", 0.9, "resolved")]);
		graph.incoming.set(b.id, [createEdge(a.id, b.id, 1.0, "import", 0.9, "resolved")]);
		graph.fileCalls.set("a.ts", [[b.id, 1, "call"]]);
		return graph;
	}

	/**
	 * Build a true V3.0 buffer by re-encoding the V3.2 payload with
	 * a V3.0-shape: no string table, source / target live inline on
	 * the EdgeColumn message. We do this by hand because there is no
	 * V3.0-specific ProtoBuf schema defined (the V3.0 wire format
	 * is the V3.1 wire format minus the index columns, and
	 * protobufjs will populate the inline string fields from any
	 * source/target data we put in the payload).
	 */
	function buildV30Buffer(graph: RepoGraph): Buffer {
		const v32 = serializeGraphV3(graph);
		const payload = decodeGraphPayload(stripMagic(v32)) as ProtoGraphPayload;
		// V3.0 has source / target on EdgeColumn (not the string
		// table). We reconstruct those from the string table +
		// index columns, then drop the string table (V3.0 doesn't
		// have it).
		const stringTable = payload.string_table ?? [];
		const sourceIdx = payload.edge_source_idx ?? [];
		const targetIdx = payload.edge_target_idx ?? [];
		const inlineSource: string[] = [];
		const inlineTarget: string[] = [];
		for (let i = 0; i < sourceIdx.length; i++) {
			inlineSource.push(stringTable[sourceIdx[i]!] ?? "");
			inlineTarget.push(stringTable[targetIdx[i]!] ?? "");
		}
		// Build a V3.0-shaped payload: V3.1 schema (kind=string)
		// but with `string_table` empty and source/target inline.
		const v30Payload: ProtoGraphPayloadV31 = {
			metadata: payload.metadata,
			edges: {
				source: inlineSource,
				target: inlineTarget,
				weight: payload.edges!.weight,
				// Map int back to string for the V3.1 schema.
				kind: (payload.edges!.kind as unknown as number[]).map((n) => {
					switch (n) {
						case 0:
							return "call";
						case 1:
							return "type";
						case 2:
							return "import";
						case 3:
							return "ref";
						case 4:
							return "typeRef";
						case 5:
							return "import-binding";
						default:
							return "call";
					}
				}),
				confidence: payload.edges!.confidence,
				provenance: payload.edges!.provenance,
			},
			file_edges: {
				file: payload.file_edges!.file,
				symbol_id: payload.file_edges!.symbol_id,
				count: payload.file_edges!.count,
				kind: (payload.file_edges!.kind as unknown as number[]).map((n) => {
					switch (n) {
						case 0:
							return "call";
						case 3:
							return "ref";
						case 4:
							return "typeRef";
						default:
							return "call";
					}
				}),
			},
			string_table: [],
			edge_source_idx: [],
			edge_target_idx: [],
		};
		return Buffer.concat([CACHE_V3_0_MAGIC, encodeGraphPayloadV31(v30Payload)]);
	}

	it("V3.1 reader (magic 0x04) recovers the graph from a true V3.1 buffer", () => {
		// Build a true V3.1 buffer using the V3.1-specific schema
		// (kind as string). This exercises the V3.1 dispatch path
		// end-to-end: magic check, V3.1-specific decode, metadata
		// rebuild, edge rebuild.
		const graph = buildLegacyFixture();
		// Decode the V3.2 buffer, re-encode with the V3.1 schema
		// (kind becomes a string again), then patch the magic.
		const v32 = serializeGraphV3(graph);
		const v32Payload = decodeGraphPayload(stripMagic(v32)) as ProtoGraphPayload;
		const v31Payload: ProtoGraphPayloadV31 = {
			metadata: v32Payload.metadata,
			edges: {
				source: v32Payload.edges!.source,
				target: v32Payload.edges!.target,
				weight: v32Payload.edges!.weight,
				// Map int kind back to its string form (2 -> "import").
				kind: (v32Payload.edges!.kind as unknown as number[]).map((n) => {
					switch (n) {
						case 0:
							return "call";
						case 1:
							return "type";
						case 2:
							return "import";
						case 3:
							return "ref";
						case 4:
							return "typeRef";
						case 5:
							return "import-binding";
						default:
							return "call";
					}
				}),
				confidence: v32Payload.edges!.confidence,
				provenance: v32Payload.edges!.provenance,
			},
			file_edges: {
				file: v32Payload.file_edges!.file,
				symbol_id: v32Payload.file_edges!.symbol_id,
				count: v32Payload.file_edges!.count,
				// file-level kind is also int in V3.2 (only "call"=0,
				// "ref"=3, "typeRef"=4 are actually used here).
				kind: (v32Payload.file_edges!.kind as unknown as number[]).map((n) => {
					switch (n) {
						case 0:
							return "call";
						case 3:
							return "ref";
						case 4:
							return "typeRef";
						default:
							return "call";
					}
				}),
			},
			string_table: v32Payload.string_table ?? [],
			edge_source_idx: v32Payload.edge_source_idx ?? [],
			edge_target_idx: v32Payload.edge_target_idx ?? [],
		};
		const v31 = Buffer.concat([CACHE_V3_1_MAGIC, encodeGraphPayloadV31(v31Payload)]);
		const loaded = deserializeGraphV3V1(v31);
		expect(loaded.symbols.size).toBe(2);
		const edge = loaded.outgoing.get("a.ts::a::1")?.[0];
		expect(edge).toBeDefined();
		expect(edge?.target).toBe("b.ts::b::1");
		expect(edge?.kind).toBe("import");
		expect(edge?.provenance).toBe("resolved");
	});

	it("V3.1 reader rejects a V3.2 buffer (V3.2 kind int != V3.1 kind string wire type)", () => {
		// A real V3.2 buffer has `kind` encoded as int32 varint.
		// The V3.1 reader's schema (kind=string) tries to read
		// the same bytes as a length-delimited string, which
		// would misinterpret the wire. The V3.1 reader therefore
		// rejects V3.2 buffers via the magic check (the magic
		// is 0x05, not 0x04). This is the expected behavior:
		// only true V3.1 buffers should pass the magic check.
		const graph = buildLegacyFixture();
		const v32 = serializeGraphV3(graph);
		expect(() => deserializeGraphV3V1(v32)).toThrow(/magic/i);
	});

	it("V3.0 reader (magic 0x03) recovers the graph from a true V3.0 buffer", () => {
		// V3.0 = V3.1 wire minus the string table. The V3.0 reader
		// reads source / target from the inline `edges.source` /
		// `edges.target` fields. We construct a true V3.0 buffer
		// (inline source/target, no index columns) and verify
		// the V3.0 reader restores the graph.
		const graph = buildLegacyFixture();
		const v30 = buildV30Buffer(graph);
		const loaded = deserializeGraphV3V0(v30);
		expect(loaded.symbols.size).toBe(2);
		const edge = loaded.outgoing.get("a.ts::a::1")?.[0];
		expect(edge).toBeDefined();
		expect(edge?.target).toBe("b.ts::b::1");
		expect(edge?.kind).toBe("import");
		expect(edge?.provenance).toBe("resolved");
	});

	it("V3.0 reader rejects a V3.2 cache (wrong magic) without crashing", () => {
		const graph = buildLegacyFixture();
		const v32 = serializeGraphV3(graph);
		expect(() => deserializeGraphV3V0(v32)).toThrow(/magic/i);
	});
});

describe("V3 targetToSources reverse index (issue #752)", () => {
	// Build a graph with cross-file symbol edges where targetToSources is
	// maintained exactly as addEdge (scanner.ts:1242) does in production.
	// The V3 deserializer must rebuild this derived index from the edges,
	// otherwise the first incremental scan after a cache load (which reads
	// targetToSources in _cleanEdgesForSymbols, scanner.ts:339) cannot clean
	// stale cross-file edges.
	function buildEdgeFixture(): RepoGraph {
		const graph = createRepoGraph();
		const a = createSymbol("src/a.ts::a::1", "a", "function", "src/a.ts", 1);
		const b = createSymbol("src/b.ts::b::1", "b", "function", "src/b.ts", 1);
		const c = createSymbol("src/c.ts::c::1", "c", "function", "src/c.ts", 1);
		for (const s of [a, b, c]) {
			graph.symbols.set(s.id, s);
			graph.fileSymbols.set(s.file, [s.id]);
		}
		const e1 = createEdge(a.id, b.id, 1.0, "call", 0.9, "resolved");
		const e2 = createEdge(b.id, c.id, 1.0, "call", 0.9, "resolved");
		const e3 = createEdge(a.id, c.id, 1.0, "type", 0.5, "name_match");
		graph.outgoing.set(a.id, [e1, e3]);
		graph.outgoing.set(b.id, [e2]);
		graph.incoming.set(b.id, [e1]);
		graph.incoming.set(c.id, [e2, e3]);
		// Reverse index — the value the V3 load must reconstruct.
		graph.targetToSources.set(b.id, new Set([a.id]));
		graph.targetToSources.set(c.id, new Set([a.id, b.id]));
		return graph;
	}

	it("V3 deserialize reconstructs targetToSources from edges", () => {
		const graph = buildEdgeFixture();
		const buf = serializeGraphV3(graph);
		const loaded = deserializeGraphV3(buf);
		expect(loaded.targetToSources.size).toBe(graph.targetToSources.size);
		for (const [target, sources] of graph.targetToSources) {
			expect(loaded.targetToSources.get(target)).toEqual(sources);
		}
	});

	it("loadGraphCache (V3) populates targetToSources for incremental scan", () => {
		const graph = buildEdgeFixture();
		const cachePath = join(tmpdir(), `shazam-v3-tts-${process.pid}-${Date.now()}.bin`);
		try {
			const result = saveGraphCache(graph, new Map(), cachePath);
			expect(result.persisted).toBe(true);
			const loaded = loadGraphCache(cachePath);
			expect(loaded).not.toBeNull();
			expect(loaded!.graph.targetToSources.size).toBe(graph.targetToSources.size);
			for (const [target, sources] of graph.targetToSources) {
				expect(loaded!.graph.targetToSources.get(target)).toEqual(sources);
			}
		} finally {
			try {
				unlinkSync(cachePath);
			} catch {
				/* best-effort cleanup */
			}
		}
	});
});

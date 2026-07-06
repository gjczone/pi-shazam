/**
 * Cache migration test for issue #633: provenance field round-trip.
 *
 * Caches written before #633 didn't carry a `provenance` field on
 * edges. After the upgrade, `deserializeGraphV2` must still load those
 * legacy caches without losing data, defaulting every missing field to
 * "heuristic" so downstream callers see a stable, well-typed value.
 *
 * The cache version header is already `3` (no bump required); the
 * schema gains an OPTIONAL field, which JSON deserializers treat as
 * absent on old data.
 */
import { describe, it, expect } from "vitest";
import {
	createRepoGraph,
	createSymbol,
	createEdge,
	serializeGraphV2,
	deserializeGraphV2,
	type SerializedGraphV2,
} from "../core/graph.js";

function buildLegacyGraph(): {
	graph: ReturnType<typeof createRepoGraph>;
	source: ReturnType<typeof createSymbol>;
	target: ReturnType<typeof createSymbol>;
} {
	const graph = createRepoGraph();
	const source = createSymbol("src/foo.ts::foo::1", "foo", "function", "src/foo.ts", 1);
	const target = createSymbol("src/bar.ts::bar::5", "bar", "function", "src/bar.ts", 5);
	for (const s of [source, target]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
		const list = graph.nameIndex.get(s.name) ?? [];
		list.push(s);
		graph.nameIndex.set(s.name, list);
	}
	const edge = createEdge(source.id, target.id, 1.0, "call", 0.9);
	graph.outgoing.set(source.id, [edge]);
	graph.incoming.set(target.id, [edge]);
	return { graph, source, target };
}

describe("Cache v2 -> v3 migration: provenance field", () => {
	it("v2 cache (no provenance field) loads as v3 with edges defaulted to 'heuristic'", () => {
		const { graph, source } = buildLegacyGraph();
		const serialized = serializeGraphV2(graph, new Map());

		// Simulate a pre-#633 cache file by stripping the provenance field
		// from every edge. This mirrors what an old pi-shazam version would
		// have written before the upgrade.
		const legacySerialized: SerializedGraphV2 = {
			...serialized,
			edges: serialized.edges.map((e) => {
				// Object spread + delete keeps the type strict (no `any`).
				const { provenance: _drop, ...rest } = e;
				return rest;
			}),
		};
		expect(legacySerialized.edges[0].provenance).toBeUndefined();

		const loaded = deserializeGraphV2(legacySerialized);
		const edge = loaded.outgoing.get(source.id)?.[0];
		expect(edge).toBeDefined();
		expect(edge?.provenance).toBe("heuristic");
	});

	it("v3 cache (with provenance) round-trips exactly", () => {
		const { graph, source } = buildLegacyGraph();
		// Promote the single edge to "resolved" before serializing.
		const promotedEdge = { ...graph.outgoing.get(source.id)![0], provenance: "resolved" as const };
		graph.outgoing.set(source.id, [promotedEdge]);

		const serialized = serializeGraphV2(graph, new Map());
		expect(serialized.edges[0].provenance).toBe("resolved");

		const loaded = deserializeGraphV2(serialized);
		const edge = loaded.outgoing.get(source.id)?.[0];
		expect(edge?.provenance).toBe("resolved");
	});

	it("v3 cache with mixed provenance values (heuristic + resolved + name_match) round-trips", () => {
		const graph = createRepoGraph();
		const sym = (id: string, name: string, file: string, line: number) =>
			createSymbol(id, name, "function", file, line);

		const a = sym("src/a.ts::a::1", "a", "src/a.ts", 1);
		const b = sym("src/b.ts::b::1", "b", "src/b.ts", 1);
		const c = sym("src/c.ts::c::1", "c", "src/c.ts", 1);
		for (const s of [a, b, c]) {
			graph.symbols.set(s.id, s);
			graph.fileSymbols.set(s.file, [s.id]);
		}

		const e1 = createEdge(a.id, b.id, 1.0, "call", 0.9, "resolved");
		const e2 = createEdge(b.id, c.id, 1.0, "call", 0.9, "name_match");
		const e3 = createEdge(a.id, c.id, 1.0, "call", 0.9, "unresolved");
		graph.outgoing.set(a.id, [e1, e3]);
		graph.outgoing.set(b.id, [e2]);

		const serialized = serializeGraphV2(graph, new Map());
		const loaded = deserializeGraphV2(serialized);

		expect(loaded.outgoing.get(a.id)?.[0].provenance).toBe("resolved");
		expect(loaded.outgoing.get(a.id)?.[1].provenance).toBe("unresolved");
		expect(loaded.outgoing.get(b.id)?.[0].provenance).toBe("name_match");
	});

	it("incoming edge index also carries the migrated provenance", () => {
		const { graph, target } = buildLegacyGraph();
		const serialized = serializeGraphV2(graph, new Map());
		// Strip provenance to simulate v2.
		const legacySerialized: SerializedGraphV2 = {
			...serialized,
			edges: serialized.edges.map((e) => {
				const { provenance: _drop, ...rest } = e;
				return rest;
			}),
		};

		const loaded = deserializeGraphV2(legacySerialized);
		const incomingEdge = loaded.incoming.get(target.id)?.[0];
		expect(incomingEdge?.provenance).toBe("heuristic");
	});
});

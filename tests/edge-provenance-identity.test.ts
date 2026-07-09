/**
 * Tests for issue #695: edge provenance must be part of the edge identity
 * used by compareGraphSnapshots, so shazam_changes detects a provenance-only
 * edge update (e.g. heuristic -> resolved via LSP) as a real change rather
 * than treating the edge as identical.
 *
 * Minimum-scope verification:
 *  - edgeIdentity includes the provenance value.
 *  - Two edges that differ only by provenance produce different identities.
 *  - compareGraphSnapshots reports a changed edge when only provenance differs.
 */
import { describe, it, expect } from "vitest";
import {
	createEdge,
	edgeIdentity,
	compareGraphSnapshots,
	serializeEdge,
	type Edge,
	type SerializedEdge,
} from "../core/graph.js";

function edgeRow(provenance: Edge["provenance"]): SerializedEdge {
	const e = createEdge("src/a.ts::foo::1", "src/b.ts::bar::5", 1.0, "call", 0.9, provenance);
	return serializeEdge(e);
}

describe("issue #695: edgeIdentity includes provenance", () => {
	it("edgeIdentity string contains the provenance value", () => {
		const edge = createEdge("a", "b", 1.0, "call", 0.9, "resolved");
		const id = edgeIdentity(edge);
		expect(id).toContain("resolved");
		// Identity layout ends with the provenance segment.
		expect(id.endsWith("resolved")).toBe(true);
	});

	it("two edges differing only by provenance have different identities", () => {
		const heuristic = createEdge("a", "b", 1.0, "call", 0.9, "heuristic");
		const resolved = createEdge("a", "b", 1.0, "call", 0.9, "resolved");
		expect(edgeIdentity(heuristic)).not.toBe(edgeIdentity(resolved));
	});

	it("compareGraphSnapshots flags a provenance-only edge update", () => {
		const prev = [edgeRow("heuristic")];
		const current = [createEdge("src/a.ts::foo::1", "src/b.ts::bar::5", 1.0, "call", 0.9, "resolved")];

		const result = compareGraphSnapshots([], current, [], prev);
		// The edge's source/target/kind/weight/confidence are identical, so
		// without provenance in the identity this would be 0 changes.
		expect(result.summary.edgesAdded).toBe(1);
		expect(result.summary.edgesRemoved).toBe(1);
	});

	it("compareGraphSnapshots reports no edge change for identical provenance", () => {
		const prev = [edgeRow("resolved")];
		const current = [createEdge("src/a.ts::foo::1", "src/b.ts::bar::5", 1.0, "call", 0.9, "resolved")];

		const result = compareGraphSnapshots([], current, [], prev);
		expect(result.summary.edgesAdded).toBe(0);
		expect(result.summary.edgesRemoved).toBe(0);
	});
});

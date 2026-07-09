/**
 * Tests for issue #693: when a scan hits MAX_FILES the returned graph must
 * carry `graph.truncated = true`, and shazam_overview must surface a warning
 * so the agent knows results may miss dependencies.
 *
 * Minimum-scope verification:
 *  - RepoGraph exposes an optional `truncated` field.
 *  - executeOverview emits the MAX_FILES warning when graph.truncated is true.
 *  - buildOverviewResult exposes a `truncated` flag when graph.truncated is true.
 */
import { describe, it, expect } from "vitest";
import { createRepoGraph, createSymbol } from "../core/graph.js";
import { executeOverview, buildOverviewResult } from "../tools/overview.js";
import type { RepoGraph } from "../core/graph.js";

const WARNING =
	"[WARNING] File count exceeded MAX_FILES — the analysis graph is incomplete. Results may miss dependencies.";

function buildTruncatedGraph(truncated: boolean): RepoGraph {
	const graph = createRepoGraph();
	graph.truncated = truncated;
	const sym = createSymbol("src/a.ts::foo::1", "foo", "function", "src/a.ts", 1);
	graph.symbols.set(sym.id, sym);
	graph.fileSymbols.set(sym.file, [sym.id]);
	return graph;
}

describe("issue #693: RepoGraph.truncated field", () => {
	it("is absent on a normal graph", () => {
		const graph = createRepoGraph();
		expect(graph.truncated).toBeUndefined();
	});

	it("can be set true to signal MAX_FILES truncation", () => {
		const graph = createRepoGraph();
		graph.truncated = true;
		expect(graph.truncated).toBe(true);
	});
});

describe("issue #693: overview surfaces the truncation warning", () => {
	it("executeOverview emits the warning when truncated", () => {
		const out = executeOverview(buildTruncatedGraph(true), "/root");
		expect(out).toContain(WARNING);
	});

	it("executeOverview omits the warning when not truncated", () => {
		const out = executeOverview(buildTruncatedGraph(false), "/root");
		expect(out).not.toContain(WARNING);
	});

	it("buildOverviewResult exposes truncated:true when truncated", () => {
		const result = buildOverviewResult(buildTruncatedGraph(true), "/root");
		expect(result.truncated).toBe(true);
	});

	it("buildOverviewResult omits truncated when not truncated", () => {
		const result = buildOverviewResult(buildTruncatedGraph(false), "/root");
		expect(result.truncated).toBeUndefined();
	});
});

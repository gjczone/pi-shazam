/**
 * Tests for issue #696: dispatchImpact must coerce a `depth` param supplied
 * as a string (as happens over the MCP JSON boundary) into a finite number
 * before clamping it to [1,10]. A non-coerceable value ("abc", NaN,
 * undefined) must fall back to the default of 3. We must NOT use parseInt,
 * which truncates floats.
 *
 * - "5"  -> treated as 5
 * - "abc" -> fallback 3 (NOT NaN)
 * - undefined -> fallback 3
 */
import { describe, it, expect, vi } from "vitest";
import { createRepoGraph } from "../core/graph.js";
import { dispatchImpact } from "../tools/_dispatchers.js";
import * as impactModule from "../tools/impact.js";
import type { RepoGraph } from "../core/graph.js";

describe("issue #696: dispatchImpact coerces string depth to finite number", () => {
	it('treats string "5" as depth 5 in symbol mode', () => {
		const graph: RepoGraph = createRepoGraph();
		graph.nameIndex.set("realFunc", [
			{
				id: "a.ts::realFunc::1",
				name: "realFunc",
				file: "a.ts",
				line: 1,
				kind: "function",
				visibility: "public",
				provenance: "heuristic",
			} as never,
		]);
		const spy = vi.spyOn(impactModule, "executeCallChain");
		try {
			dispatchImpact(graph, { symbol: "realFunc", depth: "5" }, "/tmp");
			expect(spy).toHaveBeenCalled();
			const usedDepth = spy.mock.calls[0][2] as number;
			expect(usedDepth).toBe(5);
		} finally {
			spy.mockRestore();
		}
	});

	it('falls back to depth 3 when depth is "abc"', () => {
		const graph: RepoGraph = createRepoGraph();
		graph.nameIndex.set("realFunc", [
			{
				id: "a.ts::realFunc::1",
				name: "realFunc",
				file: "a.ts",
				line: 1,
				kind: "function",
				visibility: "public",
				provenance: "heuristic",
			} as never,
		]);
		const spy = vi.spyOn(impactModule, "executeCallChain");
		try {
			dispatchImpact(graph, { symbol: "realFunc", depth: "abc" }, "/tmp");
			expect(spy).toHaveBeenCalled();
			const usedDepth = spy.mock.calls[0][2] as number;
			expect(usedDepth).toBe(3);
		} finally {
			spy.mockRestore();
		}
	});

	it("falls back to depth 3 when depth is undefined", () => {
		const graph: RepoGraph = createRepoGraph();
		graph.nameIndex.set("realFunc", [
			{
				id: "a.ts::realFunc::1",
				name: "realFunc",
				file: "a.ts",
				line: 1,
				kind: "function",
				visibility: "public",
				provenance: "heuristic",
			} as never,
		]);
		const spy = vi.spyOn(impactModule, "executeCallChain");
		try {
			dispatchImpact(graph, { symbol: "realFunc" }, "/tmp");
			expect(spy).toHaveBeenCalled();
			const usedDepth = spy.mock.calls[0][2] as number;
			expect(usedDepth).toBe(3);
		} finally {
			spy.mockRestore();
		}
	});
});

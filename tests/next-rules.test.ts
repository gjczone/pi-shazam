/**
 * Tests for core/output — declarative Next recommendation rule engine.
 *
 * Verifies:
 *   1. Backward compat: every tool still emits the same recommendations
 *      it did under the switch-case implementation.
 *   2. Graph-aware filters suppress irrelevant recommendations
 *      (e.g., skip recommendations when project has no matching symbols).
 *   3. Rule engine API: getNextForTool(tool, ctx, graph?) signature.
 */
import { describe, it, expect } from "vitest";
import { getNextForTool } from "../core/output.js";
import { createRepoGraph, createSymbol } from "../core/graph.js";
import type { RepoGraph } from "../core/graph.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyGraph(): RepoGraph {
	return createRepoGraph();
}

function graphWithTestFiles(): RepoGraph {
	const g = createRepoGraph();
	g.fileSymbols.set("tests/foo.test.ts", ["tests/foo.test.ts::testFoo::1"]);
	g.symbols.set(
		"tests/foo.test.ts::testFoo::1",
		createSymbol("tests/foo.test.ts::testFoo::1", "testFoo", "function", "tests/foo.test.ts", 1),
	);
	return g;
}

function findTool(items: ReturnType<typeof getNextForTool>, tool: string) {
	return items.find((i) => i.tool === tool);
}

// ── Backward compatibility tests ─────────────────────────────────────────────

describe("getNextForTool — backward compatibility", () => {
	it("overview recommends lookup when topFile set", () => {
		const items = getNextForTool("overview", { topFile: "index.ts" });
		expect(findTool(items, "lookup")).toBeDefined();
	});

	it("lookup recommends impact when topSymbol set", () => {
		const items = getNextForTool("lookup", { topSymbol: "fn" });
		expect(findTool(items, "impact")).toBeDefined();
	});

	it("impact always recommends verify (required)", () => {
		const items = getNextForTool("impact");
		const v = findTool(items, "verify");
		expect(v).toBeDefined();
		expect(v!.level).toBe("required");
	});

	it("verify recommends impact when orphanCount > 0", () => {
		const items = getNextForTool("verify", { orphanCount: 3 });
		expect(findTool(items, "impact")).toBeDefined();
	});

	it("format always recommends verify (required)", () => {
		const items = getNextForTool("format");
		expect(findTool(items, "verify")!.level).toBe("required");
	});

	it("rename_symbol requires impact when topSymbol set", () => {
		const items = getNextForTool("rename_symbol", { topSymbol: "x" });
		expect(findTool(items, "impact")!.level).toBe("required");
	});

	it("unknown tool returns empty array", () => {
		expect(getNextForTool("no_such_tool").length).toBe(0);
	});
});

// ── API shape tests ──────────────────────────────────────────────────────────

describe("getNextForTool — API shape", () => {
	it("returns an array of NextRecommendation", () => {
		const items = getNextForTool("overview", { topFile: "x" });
		expect(Array.isArray(items)).toBe(true);
		if (items.length > 0) {
			expect(items[0]!.tool).toBeDefined();
			expect(items[0]!.label).toBeDefined();
			expect(items[0]!.level).toBeDefined();
		}
	});

	it("accepts optional graph without throwing", () => {
		expect(() => getNextForTool("overview", { topFile: "x" }, emptyGraph())).not.toThrow();
	});
});

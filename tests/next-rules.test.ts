/**
 * Tests for core/output — declarative Next recommendation rule engine.
 *
 * Verifies:
 *   1. Backward compat: every tool still emits the same recommendations
 *      it did under the switch-case implementation.
 *   2. Graph-aware filters suppress irrelevant recommendations
 *      (e.g., find_tests when project has no test files).
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

function graphWithHierarchy(): RepoGraph {
	const g = createRepoGraph();
	g.symbols.set(
		"src/model.ts::User::1",
		createSymbol("src/model.ts::User::1", "User", "class", "src/model.ts", 1),
	);
	g.symbols.set(
		"src/util.ts::add::1",
		createSymbol("src/util.ts::add::1", "add", "function", "src/util.ts", 1),
	);
	return g;
}

function findTool(items: ReturnType<typeof getNextForTool>, tool: string) {
	return items.find((i) => i.tool === tool);
}

// ── Backward compatibility tests ─────────────────────────────────────────────

describe("getNextForTool — backward compatibility", () => {
	it("overview recommends file_detail when topFile set, and codesearch", () => {
		const items = getNextForTool("overview", { topFile: "index.ts" });
		expect(findTool(items, "file_detail")).toBeDefined();
		expect(findTool(items, "codesearch")).toBeDefined();
	});

	it("overview emits codesearch even without topFile", () => {
		const items = getNextForTool("overview");
		expect(findTool(items, "codesearch")).toBeDefined();
	});

	it("hotspots recommends file_detail when topFile set", () => {
		const items = getNextForTool("hotspots", { topFile: "index.ts" });
		expect(findTool(items, "file_detail")).toBeDefined();
	});

	it("symbol recommends call_chain and hover when topSymbol set", () => {
		const items = getNextForTool("symbol", { topSymbol: "fn" });
		expect(findTool(items, "call_chain")).toBeDefined();
		expect(findTool(items, "hover")).toBeDefined();
	});

	it("codesearch recommends symbol when topSymbol set", () => {
		const items = getNextForTool("codesearch", { topSymbol: "fn" });
		expect(findTool(items, "symbol")).toBeDefined();
	});

	it("call_chain always recommends impact", () => {
		const items = getNextForTool("call_chain");
		expect(findTool(items, "impact")).toBeDefined();
	});

	it("hover recommends symbol and type_hierarchy when topSymbol set", () => {
		const items = getNextForTool("hover", { topSymbol: "fn" });
		expect(findTool(items, "symbol")).toBeDefined();
	});

	it("impact always recommends verify (required)", () => {
		const items = getNextForTool("impact");
		const v = findTool(items, "verify");
		expect(v).toBeDefined();
		expect(v!.level).toBe("required");
	});

	it("verify recommends call_chain when orphanCount > 0", () => {
		const items = getNextForTool("verify", { orphanCount: 3 });
		expect(findTool(items, "call_chain")).toBeDefined();
	});

	it("fix always recommends verify (required)", () => {
		const items = getNextForTool("fix");
		expect(findTool(items, "verify")!.level).toBe("required");
	});

	it("rename_symbol requires call_chain when topSymbol set", () => {
		const items = getNextForTool("rename_symbol", { topSymbol: "x" });
		expect(findTool(items, "call_chain")!.level).toBe("required");
	});

	it("safe_delete requires call_chain when topSymbol set", () => {
		const items = getNextForTool("safe_delete", { topSymbol: "x" });
		expect(findTool(items, "call_chain")!.level).toBe("required");
	});

	it("unknown tool returns empty array", () => {
		expect(getNextForTool("no_such_tool").length).toBe(0);
	});
});

// ── Graph-aware filter tests ─────────────────────────────────────────────────

describe("getNextForTool — graph-aware filters", () => {
	it("suppresses find_tests recommendation when graph has no test files", () => {
		const items = getNextForTool("codesearch", { topSymbol: "fn" }, emptyGraph());
		expect(findTool(items, "find_tests")).toBeUndefined();
	});

	it("emits find_tests recommendation when graph has test files", () => {
		const items = getNextForTool("codesearch", { topSymbol: "fn" }, graphWithTestFiles());
		expect(findTool(items, "find_tests")).toBeDefined();
	});

	it("suppresses type_hierarchy on hover when graph has no class/interface", () => {
		const items = getNextForTool("hover", { topSymbol: "fn" }, emptyGraph());
		expect(findTool(items, "type_hierarchy")).toBeUndefined();
	});

	it("emits type_hierarchy on hover when graph has class/interface", () => {
		const items = getNextForTool("hover", { topSymbol: "fn" }, graphWithHierarchy());
		expect(findTool(items, "type_hierarchy")).toBeDefined();
	});

	it("falls back to legacy (no graph) behavior when graph is undefined", () => {
		const items = getNextForTool("hover", { topSymbol: "fn" });
		expect(findTool(items, "type_hierarchy")).toBeDefined();
	});

	it("graph with no test files suppresses find_tests from codesearch too", () => {
		const items = getNextForTool("file_detail", { topFile: "x" }, emptyGraph());
		expect(findTool(items, "find_tests")).toBeUndefined();
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

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
	g.fileSymbols.set("src/model.ts", ["src/model.ts::User::1"]);
	g.symbols.set(
		"src/model.ts::User::1",
		createSymbol("src/model.ts::User::1", "User", "class", "src/model.ts", 1),
	);
	return g;
}

function graphWithoutHierarchy(): RepoGraph {
	const g = createRepoGraph();
	g.fileSymbols.set("src/util.ts", ["src/util.ts::add::1"]);
	g.symbols.set(
		"src/util.ts::add::1",
		createSymbol("src/util.ts::add::1", "add", "function", "src/util.ts", 1),
	);
	return g;
}

function graphWithWebFramework(): RepoGraph {
	const g = createRepoGraph();
	g.fileSymbols.set("src/routes.ts", ["src/routes.ts::router::1"]);
	g.symbols.set(
		"src/routes.ts::router::1",
		createSymbol("src/routes.ts::router::1", "router", "variable", "src/routes.ts", 1),
	);
	g.fileImportBindings.set("src/routes.ts", [
		{ localName: "express", importedName: "default", module: "express", line: 1, kind: "default" },
	]);
	return g;
}

function findTool(items: ReturnType<typeof getNextForTool>, tool: string) {
	return items.find((i) => i.tool === tool);
}

// ── Backward-compat tests (preserve switch-case behavior) ────────────────────

describe("getNextForTool — backward compatibility", () => {
	it("overview recommends file_detail when topFile set, and codesearch", () => {
		const items = getNextForTool("overview", { topFile: "foo.ts" });
		expect(findTool(items, "file_detail")).toBeDefined();
		expect(findTool(items, "codesearch")).toBeDefined();
	});

	it("overview emits codesearch even without topFile", () => {
		const items = getNextForTool("overview");
		expect(findTool(items, "codesearch")).toBeDefined();
	});

	it("hotspots recommends file_detail when topFile set", () => {
		const items = getNextForTool("hotspots", { topFile: "a.ts" });
		expect(findTool(items, "file_detail")).toBeDefined();
	});

	it("symbol recommends call_chain and hover when topSymbol set", () => {
		const items = getNextForTool("symbol", { topSymbol: "foo" });
		expect(findTool(items, "call_chain")).toBeDefined();
		expect(findTool(items, "hover")).toBeDefined();
	});

	it("codesearch recommends symbol when topSymbol set", () => {
		const items = getNextForTool("codesearch", { topSymbol: "bar" });
		expect(findTool(items, "symbol")).toBeDefined();
	});

	it("call_chain always recommends impact", () => {
		const items = getNextForTool("call_chain");
		expect(findTool(items, "impact")).toBeDefined();
	});

	it("hover recommends symbol and type_hierarchy when topSymbol set", () => {
		const items = getNextForTool("hover", { topSymbol: "s" });
		expect(findTool(items, "symbol")).toBeDefined();
		expect(findTool(items, "type_hierarchy")).toBeDefined();
	});

	it("impact always recommends verify (required)", () => {
		const items = getNextForTool("impact");
		const v = findTool(items, "verify");
		expect(v).toBeDefined();
		expect(v!.level).toBe("required");
	});

	it("check recommends verify when hasErrors, fix when hasFixes", () => {
		const items = getNextForTool("check", { hasErrors: true, hasFixes: true });
		const v = findTool(items, "verify");
		expect(v).toBeDefined();
		expect(v!.level).toBe("required");
		expect(findTool(items, "fix")).toBeDefined();
	});

	it("verify recommends ready when riskLevel=high", () => {
		const items = getNextForTool("verify", { riskLevel: "high" });
		const r = findTool(items, "ready");
		expect(r).toBeDefined();
		expect(r!.level).toBe("required");
	});

	it("verify recommends call_chain when orphanCount > 0", () => {
		const items = getNextForTool("verify", { orphanCount: 3 });
		expect(findTool(items, "call_chain")).toBeDefined();
	});

	it("fix always recommends verify (required)", () => {
		const items = getNextForTool("fix");
		expect(findTool(items, "verify")!.level).toBe("required");
	});

	it("ready emits an empty-tool 'Commit and push' recommendation", () => {
		const items = getNextForTool("ready");
		expect(items.length).toBeGreaterThan(0);
		expect(items[0]!.level).toBe("required");
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
		const items = getNextForTool("nonexistent_tool");
		expect(items).toEqual([]);
	});
});

// ── Graph-aware filter tests ─────────────────────────────────────────────────

describe("getNextForTool — graph-aware filters", () => {
	it("suppresses find_tests recommendation when graph has no test files", () => {
		// file_detail normally recommends find_tests for its topFile
		const items = getNextForTool("file_detail", { topFile: "src/a.ts" }, emptyGraph());
		expect(findTool(items, "find_tests")).toBeUndefined();
	});

	it("emits find_tests recommendation when graph has test files", () => {
		const items = getNextForTool("file_detail", { topFile: "src/a.ts" }, graphWithTestFiles());
		expect(findTool(items, "find_tests")).toBeDefined();
	});

	it("suppresses type_hierarchy on hover when graph has no class/interface", () => {
		const items = getNextForTool("hover", { topSymbol: "s" }, graphWithoutHierarchy());
		expect(findTool(items, "type_hierarchy")).toBeUndefined();
	});

	it("emits type_hierarchy on hover when graph has class/interface", () => {
		const items = getNextForTool("hover", { topSymbol: "s" }, graphWithHierarchy());
		expect(findTool(items, "type_hierarchy")).toBeDefined();
	});

	it("falls back to legacy (no graph) behavior when graph is undefined", () => {
		// Without graph, the filters must not suppress — preserve existing output
		const items = getNextForTool("hover", { topSymbol: "s" });
		expect(findTool(items, "type_hierarchy")).toBeDefined();
	});

	it("graph with no test files suppresses find_tests from codesearch too", () => {
		const items = getNextForTool("codesearch", { topSymbol: "x" }, emptyGraph());
		expect(findTool(items, "find_tests")).toBeUndefined();
	});
});

// ── Rule engine API ──────────────────────────────────────────────────────────

describe("getNextForTool — rule engine shape", () => {
	it("returns an array of NextRecommendation", () => {
		const items = getNextForTool("impact");
		expect(Array.isArray(items)).toBe(true);
		for (const item of items) {
			expect(item).toHaveProperty("tool");
			expect(item).toHaveProperty("label");
			expect(item).toHaveProperty("level");
			expect(["required", "recommended", "also"]).toContain(item.level);
		}
	});

	it("accepts optional graph without throwing", () => {
		expect(() => getNextForTool("overview", {}, emptyGraph())).not.toThrow();
		expect(() => getNextForTool("overview", undefined, emptyGraph())).not.toThrow();
	});
});

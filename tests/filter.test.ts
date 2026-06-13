/**
 * Tests for core/filter — findOrphans() behavior.
 *
 * Verifies:
 *  - Exported symbols are excluded from orphan detection (consumers may be external)
 *  - Internal symbols with zero incoming references are reported as orphans
 *  - Test files, registration symbols, and entry points are excluded
 */
import { describe, it, expect } from "vitest";
import { findOrphans } from "../core/filter.js";
import { createRepoGraph, createSymbol, type RepoGraph, type Symbol } from "../core/graph.js";

function buildGraph(symbols: Symbol[]): RepoGraph {
	const graph = createRepoGraph();
	for (const sym of symbols) {
		graph.symbols.set(sym.id, sym);
		graph.incoming.set(sym.id, []);
		graph.outgoing.set(sym.id, []);
	}
	return graph;
}

function sym(id: string, file: string, name: string, kind: string, visibility: "internal" | "exported"): Symbol {
	return createSymbol(id, name, kind, file, 1, { visibility });
}

describe("core/filter findOrphans", () => {
	it("should report internal symbols with zero incoming refs as orphans", () => {
		const graph = buildGraph([sym("src/util.ts::helper::1", "src/util.ts", "helper", "function", "internal")]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(1);
		expect(result.internal[0].name).toBe("helper");
	});

	it("should NOT report exported symbols as orphans regardless of PageRank", () => {
		const graph = buildGraph([
			sym("src/types.ts::MyType::1", "src/types.ts", "MyType", "interface", "exported"),
			sym("src/api.ts::publicApi::1", "src/api.ts", "publicApi", "function", "exported"),
			sym("src/util.ts::HelperClass::1", "src/util.ts", "HelperClass", "class", "exported"),
		]);
		const result = findOrphans(graph);
		expect(result.exported).toHaveLength(0);
		expect(result.all.filter((s) => s.isExported)).toHaveLength(0);
	});

	it("should skip test files", () => {
		const graph = buildGraph([
			sym("tests/foo.test.ts::h::1", "tests/foo.test.ts", "helper", "function", "internal"),
			sym("src/util_test.ts::h::1", "src/util_test.ts", "helper", "function", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should skip registration symbols (register*, createTool)", () => {
		const graph = buildGraph([
			sym("src/hooks.ts::registerMyHook::1", "src/hooks.ts", "registerMyHook", "function", "internal"),
			sym("src/factory.ts::createTool::1", "src/factory.ts", "createTool", "function", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should skip non-source files (node_modules, dist, json)", () => {
		const graph = buildGraph([
			sym("node_modules/pkg/index.ts::foo::1", "node_modules/pkg/index.ts", "foo", "function", "internal"),
			sym("dist/out.js::bar::1", "dist/out.js", "bar", "function", "internal"),
			sym("package.json::name::1", "package.json", "name", "variable", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should still report internal orphans even when exported siblings exist", () => {
		const graph = buildGraph([
			sym("src/api.ts::publicFn::1", "src/api.ts", "publicFn", "function", "exported"),
			sym("src/api.ts::_internalHelper::5", "src/api.ts", "_internalHelper", "function", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.exported).toHaveLength(0);
		expect(result.internal).toHaveLength(1);
		expect(result.internal[0].name).toBe("_internalHelper");
	});

	it("should skip entry point symbols (dunder, main)", () => {
		const graph = buildGraph([
			sym("src/mod.py::__init__::1", "src/mod.py", "__init__", "function", "internal"),
			sym("src/main.rs::main::1", "src/main.rs", "main", "function", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should skip framework handler symbols (test_*, handle_*, on_*)", () => {
		const graph = buildGraph([
			sym("src/h.py::test_something::1", "src/h.py", "test_something", "function", "internal"),
			sym("src/h.py::handle_event::1", "src/h.py", "handle_event", "function", "internal"),
			sym("src/h.py::on_start::1", "src/h.py", "on_start", "function", "internal"),
			sym("src/h.py::MyHandler::1", "src/h.py", "MyHandler", "class", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should skip symbols in side-effect-imported modules (issue #243)", () => {
		const graph = buildGraph([
			sym("src/polyfill.ts::patchArray::1", "src/polyfill.ts", "patchArray", "function", "internal"),
			sym("src/polyfill.ts::install::1", "src/polyfill.ts", "install", "function", "internal"),
			sym("src/main.ts::main::1", "src/main.ts", "main", "function", "internal"),
		]);
		// main.ts does `import './polyfill'` — file-level edge only
		graph.fileImports.set("src/main.ts", ["src/polyfill.ts"]);
		const result = findOrphans(graph);
		const names = result.internal.map((s) => s.name);
		expect(names).not.toContain("patchArray");
		expect(names).not.toContain("install");
	});

	it("should still report orphans in files that are NOT imported by anyone (issue #243)", () => {
		const graph = buildGraph([
			sym("src/stray.ts::unused::1", "src/stray.ts", "unused", "function", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(1);
		expect(result.internal[0].name).toBe("unused");
	});

	it("should skip symbols in .d.ts ambient declaration files (issue #244)", () => {
		const graph = buildGraph([
			sym("types/api.d.ts::ApiShape::1", "types/api.d.ts", "ApiShape", "interface", "internal"),
			sym("types/global.d.ts::Window::1", "types/global.d.ts", "Window", "interface", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});
});

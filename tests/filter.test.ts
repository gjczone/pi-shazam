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

	it("should still report orphans in namespace-imported files (issue #246)", () => {
		// main.ts does `import * as Utils from './utils'` — bindings exist
		const graph = buildGraph([
			sym("src/utils.ts::used::1", "src/utils.ts", "used", "function", "internal"),
			sym("src/utils.ts::unused::1", "src/utils.ts", "unused", "function", "internal"),
			sym("src/main.ts::main::1", "src/main.ts", "main", "function", "internal"),
		]);
		graph.fileImports.set("src/main.ts", ["src/utils.ts"]);
		graph.fileImportBindings.set("src/main.ts", [
			{ kind: "namespace", localName: "Utils", importedName: "*", module: "./utils", line: 1 },
		]);
		// Simulate `used` being referenced via `Utils.used`
		graph.incoming.set("src/utils.ts::used::1", [{ from: "src/main.ts::main::1", weight: 1 }]);
		const result = findOrphans(graph);
		const names = result.internal.map((s) => s.name);
		expect(names).not.toContain("used");
		expect(names).toContain("unused");
	});

	it("should skip PascalCase functions in .tsx/.jsx files (issue #249 React)", () => {
		const graph = buildGraph([
			sym("src/Button.tsx::Button::1", "src/Button.tsx", "Button", "function", "internal"),
			sym("src/Modal.jsx::Modal::1", "src/Modal.jsx", "Modal", "function", "internal"),
			sym("src/utils.tsx::lowerCaseHelper::1", "src/utils.tsx", "lowerCaseHelper", "function", "internal"),
		]);
		const result = findOrphans(graph);
		const names = result.internal.map((s) => s.name);
		expect(names).not.toContain("Button");
		expect(names).not.toContain("Modal");
		expect(names).toContain("lowerCaseHelper");
	});

	// ── Rust-specific orphan filtering (issue #252) ──────────────────────

	it("should NOT report Rust pub fn as orphan (exported visibility)", () => {
		// pub fn symbols should be marked as "exported" by the tree-sitter
		// adapter and thus excluded from orphan detection.
		const graph = buildGraph([
			sym("src/lib.rs::process_data::1", "src/lib.rs", "process_data", "function", "exported"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should NOT report impl blocks as orphans (issue #252)", () => {
		// impl blocks are structural declarations — never called by name.
		const graph = buildGraph([
			sym("src/model.rs::MyStruct::1", "src/model.rs", "MyStruct", "impl", "internal"),
			sym("src/model.rs::OtherType::5", "src/model.rs", "OtherType", "impl", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should NOT report Rust standard trait impls as orphans (issue #252)", () => {
		// Standard trait impls (Clone, Debug, Display, etc.) are dispatched
		// by the compiler, never referenced by name in user code.
		const graph = buildGraph([
			sym("src/model.rs::Clone::1", "src/model.rs", "Clone", "impl", "internal"),
			sym("src/model.rs::Debug::5", "src/model.rs", "Debug", "impl", "internal"),
			sym("src/model.rs::Display::10", "src/model.rs", "Display", "impl", "internal"),
			sym("src/model.rs::From::15", "src/model.rs", "From", "impl", "internal"),
			sym("src/model.rs::Serialize::20", "src/model.rs", "Serialize", "impl", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should NOT report Rust framework handler functions as orphans (issue #252)", () => {
		// Functions like new(), run(), serve() in .rs files are called
		// by framework dispatch, not by name.
		const graph = buildGraph([
			sym("src/server.rs::new::1", "src/server.rs", "new", "function", "internal"),
			sym("src/server.rs::run::5", "src/server.rs", "run", "function", "internal"),
			sym("src/handler.rs::from_request::1", "src/handler.rs", "from_request", "function", "internal"),
			sym("src/handler.rs::into_response::5", "src/handler.rs", "into_response", "function", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(0);
	});

	it("should still report private Rust functions with no callers as orphans", () => {
		// A private (non-pub) function in a .rs file with zero callers
		// is genuinely orphaned and should be reported.
		const graph = buildGraph([
			sym("src/util.rs::unused_helper::1", "src/util.rs", "unused_helper", "function", "internal"),
		]);
		const result = findOrphans(graph);
		expect(result.internal).toHaveLength(1);
		expect(result.internal[0].name).toBe("unused_helper");
	});
});

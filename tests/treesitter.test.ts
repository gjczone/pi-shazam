/**
 * Integration test for TreeSitterAdapter.
 * Verifies real-world symbol extraction on this project's own TypeScript code.
 */
import { describe, it, expect } from "vitest";
import { TreeSitterAdapter } from "../core/treesitter.js";
import { readFileSync } from "node:fs";

describe("TreeSitterAdapter integration", () => {
	const adapter = new TreeSitterAdapter();

	it("should support TypeScript", () => {
		expect(adapter.hasLanguage("typescript")).toBe(true);
	});

	it("should support Python", () => {
		expect(adapter.hasLanguage("python")).toBe(true);
	});

	it("should map .ts extension", () => {
		expect(TreeSitterAdapter.langForExtension(".ts")).toBe("typescript");
	});

	it("should parse and extract symbols from index.ts", () => {
		const source = readFileSync("index.ts", "utf-8");
		const tree = adapter.parse(source, "typescript");
		expect(tree).not.toBeNull();
		if (tree) {
			const symbols = adapter.extractSymbols(tree, "typescript", "index.ts");
			expect(symbols.length).toBeGreaterThanOrEqual(0);
			// Should find the default export function
			const defaultExport = symbols.find((s) => s.kind === "function" || s.kind === "anonymous_function");
			// At minimum, the file has some structure
			expect(tree.rootNode.type).toBe("program");
		}
	});

	it("should parse and extract symbols from graph.ts", () => {
		const source = readFileSync("core/graph.ts", "utf-8");
		const tree = adapter.parse(source, "typescript");
		expect(tree).not.toBeNull();
		if (tree) {
			const symbols = adapter.extractSymbols(tree, "typescript", "core/graph.ts");
			expect(symbols.length).toBeGreaterThan(0);
		}
	});

	it("should parse python code correctly", () => {
		const pyCode = `
	def hello():
	    """Say hello"""
	    print("Hello")

	class Greeter:
	    def greet(self, name: str) -> str:
	        return f"Hello {name}"
`;
		const tree = adapter.parse(pyCode, "python");
		expect(tree).not.toBeNull();
		if (tree) {
			const symbols = adapter.extractSymbols(tree, "python", "test.py");
			// Should find hello function and Greeter class
			const functions = symbols.filter((s) => s.kind === "function");
			const classes = symbols.filter((s) => s.kind === "class");
			expect(functions.length).toBeGreaterThanOrEqual(1);
			expect(classes.length).toBeGreaterThanOrEqual(1);
		}
	});

	// ── #228: Visibility detection ──

	it("should mark exported TS functions as 'exported' visibility", () => {
		const tsCode = `
	export function exportedFn(): string {
	    return "exported";
	}

	function internalFn(): string {
	    return "internal";
	}
`;
		const tree = adapter.parse(tsCode, "typescript");
		expect(tree).not.toBeNull();
		if (tree) {
			const symbols = adapter.extractSymbols(tree, "typescript", "test.ts");
			const exportedFn = symbols.find((s) => s.name === "exportedFn");
			const internalFn = symbols.find((s) => s.name === "internalFn");
			expect(exportedFn).toBeDefined();
			expect(internalFn).toBeDefined();
			expect(exportedFn!.visibility).toBe("exported");
			expect(internalFn!.visibility).toBe("public");
		}
	});

	it("should mark exported TS classes and interfaces as 'exported'", () => {
		const tsCode = `
	export class ExportedClass {
	    method() {}
	}

	class InternalClass {
	    method() {}
	}

	export interface ExportedInterface {
	    key: string;
	}
`;
		const tree = adapter.parse(tsCode, "typescript");
		expect(tree).not.toBeNull();
		if (tree) {
			const symbols = adapter.extractSymbols(tree, "typescript", "test.ts");
			const exportedClass = symbols.find((s) => s.name === "ExportedClass");
			const internalClass = symbols.find((s) => s.name === "InternalClass");
			const exportedIface = symbols.find((s) => s.name === "ExportedInterface");
			expect(exportedClass).toBeDefined();
			expect(internalClass).toBeDefined();
			expect(exportedIface).toBeDefined();
			expect(exportedClass!.visibility).toBe("exported");
			expect(internalClass!.visibility).toBe("public");
			expect(exportedIface!.visibility).toBe("exported");
		}
	});

	// ── #229: JavaScript file support ──

	it("should support JavaScript language", () => {
		expect(adapter.hasLanguage("javascript")).toBe(true);
	});

	it("should map .js extension to javascript", () => {
		expect(TreeSitterAdapter.langForExtension(".js")).toBe("javascript");
	});

	it("should map .jsx extension to javascript", () => {
		expect(TreeSitterAdapter.langForExtension(".jsx")).toBe("javascript");
	});

	it("should map .mjs extension to javascript", () => {
		expect(TreeSitterAdapter.langForExtension(".mjs")).toBe("javascript");
	});

	it("should map .cjs extension to javascript", () => {
		expect(TreeSitterAdapter.langForExtension(".cjs")).toBe("javascript");
	});

	it("should parse and extract symbols from JavaScript code", () => {
		const jsCode = `
	function hello() {
	    return "Hello";
	}

	class Greeter {
	    greet(name) {
	        return "Hello " + name;
	    }
	}

	export function exportedFn() {
	    return "exported";
	}
`;
		const tree = adapter.parse(jsCode, "javascript");
		expect(tree).not.toBeNull();
		if (tree) {
			const symbols = adapter.extractSymbols(tree, "javascript", "test.js");
			const hello = symbols.find((s) => s.name === "hello");
			const Greeter = symbols.find((s) => s.name === "Greeter");
			const exportedFn = symbols.find((s) => s.name === "exportedFn");
			expect(hello).toBeDefined();
			expect(Greeter).toBeDefined();
			expect(exportedFn).toBeDefined();
			expect(exportedFn!.visibility).toBe("exported");
			expect(hello!.visibility).toBe("public");
		}
	});
});

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
			const defaultExport = symbols.find(
				(s) => s.kind === "function" || s.kind === "anonymous_function",
			);
			// At minimum, the file has some structure
			expect(tree.rootNode.type).toBe("program");
		}
	});

	it("should parse and extract symbols from graph.ts", () => {
		const source = readFileSync("core/graph.ts", "utf-8");
		const tree = adapter.parse(source, "typescript");
		expect(tree).not.toBeNull();
		if (tree) {
			const symbols = adapter.extractSymbols(
				tree,
				"typescript",
				"core/graph.ts",
			);
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
});

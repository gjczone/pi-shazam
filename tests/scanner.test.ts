/**
 * Tests for core/scanner — project scanning + graph building.
 */
import { describe, it, expect } from "vitest";
import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("scanProject", () => {
	it("should scan the current project and return a graph with symbols", () => {
		const graph = scanProject(".");
		expect(graph).toBeDefined();
		expect(graph.symbols.size).toBeGreaterThan(0);
		// Should find at least the TreeSitterAdapter class
		const tsAdapter = [...graph.symbols.values()].find((s) => s.name === "TreeSitterAdapter");
		expect(tsAdapter).toBeDefined();
		if (tsAdapter) {
			expect(tsAdapter.kind).toBe("class");
			expect(tsAdapter.file).toContain("treesitter.ts");
		}
	});

	it("should set PageRank scores on symbols", () => {
		const graph = scanProject(".");
		const symbolsWithPR = [...graph.symbols.values()].filter((s) => s.pagerank > 0);
		expect(symbolsWithPR.length).toBeGreaterThan(0);
	});

	it("should build edges (imports and calls) between symbols", () => {
		const graph = scanProject(".");
		let totalEdges = 0;
		for (const [, edges] of graph.outgoing) {
			totalEdges += edges.length;
		}
		expect(totalEdges).toBeGreaterThan(0);
	});

	it("should scan a small TypeScript file in a temp directory", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-test-"));
		try {
			writeFileSync(
				join(tmpDir, "index.ts"),
				`
export function hello(name: string): string {
  return "Hello, " + name;
}

export function greet(): string {
  return hello("world");
}
`.trim(),
			);

			const graph = scanProject(tmpDir);
			expect(graph.symbols.size).toBeGreaterThanOrEqual(2);

			const hello = [...graph.symbols.values()].find((s) => s.name === "hello");
			expect(hello).toBeDefined();
			if (hello) {
				expect(hello.kind).toBe("function");
				expect(hello.signature).toContain("hello");
			}

			const greet = [...graph.symbols.values()].find((s) => s.name === "greet");
			expect(greet).toBeDefined();
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("should handle empty directory gracefully", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-empty-"));
		try {
			const graph = scanProject(tmpDir);
			expect(graph).toBeDefined();
			expect(graph.symbols.size).toBe(0);
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("should only scan source files, not node_modules", () => {
		const graph = scanProject(".");
		// No symbol should have node_modules in its file path
		for (const sym of graph.symbols.values()) {
			expect(sym.file).not.toContain("node_modules");
		}
	});

	it("should populate file-level mappings", () => {
		const graph = scanProject(".");
		// fileSymbols should map each file to its symbols
		expect(graph.fileSymbols.size).toBeGreaterThan(0);
		for (const [file, symIds] of graph.fileSymbols) {
			expect(Array.isArray(symIds)).toBe(true);
			for (const id of symIds) {
				expect(graph.symbols.has(id)).toBe(true);
			}
		}
	});
});

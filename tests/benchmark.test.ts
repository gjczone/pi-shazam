/**
 * Benchmark tests — detect performance regressions in scan, PageRank,
 * and codesearch on large synthetic projects.
 *
 * These tests generate synthetic source files in a temp directory,
 * run the analysis pipeline, and assert completion within time budgets.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanProject } from "../core/scanner.js";
import { createRepoGraph, createSymbol, createEdge } from "../core/graph.js";
import { calculatePageRank } from "../core/pagerank.js";
import { executeCodesearch } from "../tools/codesearch.js";
import type { RepoGraph } from "../core/graph.js";

// Track temp dirs for cleanup
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	}
});

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Generate a synthetic TypeScript project with the given number of files.
 * Each file exports a few functions with cross-references to other files.
 */
function generateSyntheticProject(fileCount: number): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "shazam-bench-"));
	tempDirs.push(tmpDir);

	// Create src/ directory
	mkdirSync(join(tmpDir, "src"), { recursive: true });

	for (let i = 0; i < fileCount; i++) {
		const fileName = `src/module_${i}.ts`;
		const imports: string[] = [];
		const exports: string[] = [];

		// Each file imports from 2-3 other random files
		const depCount = Math.min(3, fileCount);
		for (let d = 0; d < depCount; d++) {
			const depIdx = (i + d + 1) % fileCount;
			imports.push(`import { func_${depIdx} } from "./module_${depIdx}";`);
		}

		// Each file exports 3 functions
		for (let f = 0; f < 3; f++) {
			const funcName = `func_${i}_${f}`;
			const callTarget = `func_${(i + f + 1) % fileCount}_0`;
			exports.push(`export function ${funcName}(x: number): number {\n  return x + ${i + f};\n}`);
			// Add a class for variety
			if (f === 0) {
				exports.push(
					`export class Module${i}Service {\n  process(data: string): string {\n    return data + "${i}";\n  }\n}`,
				);
			}
		}

		const content = [
			`// Auto-generated benchmark module ${i}`,
			...imports,
			"",
			...exports,
			"",
			`// Re-export for chain testing`,
			`export const MODULE_ID = ${i};`,
		].join("\n");

		writeFileSync(join(tmpDir, fileName), content);
	}

	return tmpDir;
}

/**
 * Build a large synthetic RepoGraph in memory (no filesystem).
 */
function buildSyntheticGraph(nodeCount: number, edgeMultiplier: number = 3): RepoGraph {
	const graph = createRepoGraph();

	for (let i = 0; i < nodeCount; i++) {
		const id = `sym_${i}`;
		const file = `src/file_${Math.floor(i / 10)}.ts`;
		const sym = createSymbol(id, `func_${i}`, "function", file, i % 50, {
			visibility: i % 5 === 0 ? "exported" : "public",
			signature: `function func_${i}(x: number): number`,
		});
		graph.symbols.set(id, sym);

		// fileSymbols
		const existing = graph.fileSymbols.get(file) ?? [];
		existing.push(id);
		graph.fileSymbols.set(file, existing);
	}

	// Create edges: each node points to edgeMultiplier random targets
	for (let i = 0; i < nodeCount; i++) {
		const srcId = `sym_${i}`;
		const edges: ReturnType<typeof createEdge>[] = [];
		for (let e = 0; e < edgeMultiplier; e++) {
			const tgtIdx = (i + e + 1) % nodeCount;
			const tgtId = `sym_${tgtIdx}`;
			edges.push(createEdge(srcId, tgtId, 1.0, "call"));
		}
		graph.outgoing.set(srcId, edges);

		// Build incoming
		for (const edge of edges) {
			const inc = graph.incoming.get(edge.target) ?? [];
			inc.push(edge);
			graph.incoming.set(edge.target, inc);
		}
	}

	// nameIndex
	for (const sym of graph.symbols.values()) {
		const arr = graph.nameIndex.get(sym.name) ?? [];
		arr.push(sym);
		graph.nameIndex.set(sym.name, arr);
	}

	return graph;
}

// ── Benchmark: scanProject ───────────────────────────────────────────────

describe("Benchmark: scanProject", () => {
	it("should scan 100 TypeScript files within 30s", () => {
		const tmpDir = generateSyntheticProject(100);
		const t0 = performance.now();
		const graph = scanProject(tmpDir);
		const elapsed = performance.now() - t0;

		expect(graph.symbols.size).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(30_000);
	});

	it("should scan 500 TypeScript files within 30s", () => {
		const tmpDir = generateSyntheticProject(500);
		const t0 = performance.now();
		const graph = scanProject(tmpDir);
		const elapsed = performance.now() - t0;

		expect(graph.symbols.size).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(30_000);
	});

	it("should scan a small project (< 10 files) in under 5s", () => {
		const tmpDir = generateSyntheticProject(5);
		const t0 = performance.now();
		const graph = scanProject(tmpDir);
		const elapsed = performance.now() - t0;

		expect(graph.symbols.size).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(5_000);
	});
});

// ── Benchmark: PageRank computation ──────────────────────────────────────

describe("Benchmark: PageRank computation", () => {
	it("should compute PageRank on 1000 nodes within 10s", () => {
		const graph = buildSyntheticGraph(1000, 3);

		const t0 = performance.now();
		calculatePageRank(graph);
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(10_000);

		// Verify scores were assigned
		const scores = [...graph.symbols.values()].map((s) => s.pagerank);
		const totalScore = scores.reduce((a, b) => a + b, 0);
		expect(totalScore).toBeGreaterThan(0);

		// Verify convergence: scores should sum to ~1.0
		expect(Math.abs(totalScore - 1.0)).toBeLessThan(0.01);
	});

	it("should compute PageRank on 5000 nodes within 30s", () => {
		const graph = buildSyntheticGraph(5000, 3);

		const t0 = performance.now();
		calculatePageRank(graph);
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(30_000);

		// Verify scores
		const scores = [...graph.symbols.values()].map((s) => s.pagerank);
		const totalScore = scores.reduce((a, b) => a + b, 0);
		expect(totalScore).toBeGreaterThan(0);
		expect(Math.abs(totalScore - 1.0)).toBeLessThan(0.01);
	});

	it("should compute PageRank on a small graph (< 100 nodes) in under 1s", () => {
		const graph = buildSyntheticGraph(50, 2);

		const t0 = performance.now();
		calculatePageRank(graph);
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(1_000);
	});

	it("should handle a graph with no edges gracefully", () => {
		const graph = buildSyntheticGraph(100, 0);

		const t0 = performance.now();
		calculatePageRank(graph);
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(1_000);

		// With no edges, all nodes should get uniform score
		const scores = [...graph.symbols.values()].map((s) => s.pagerank);
		const totalScore = scores.reduce((a, b) => a + b, 0);
		expect(Math.abs(totalScore - 1.0)).toBeLessThan(0.01);
	});
});

// ── Benchmark: codesearch on large index ─────────────────────────────────

describe("Benchmark: codesearch", () => {
	it("should search 1000 symbols within 5s", () => {
		const graph = buildSyntheticGraph(1000, 2);

		const t0 = performance.now();
		const results = executeCodesearch(graph, "func_500");
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(5_000);
		expect(results.length).toBeGreaterThan(0);
	});

	it("should search 5000 symbols within 10s", () => {
		const graph = buildSyntheticGraph(5000, 2);

		const t0 = performance.now();
		const results = executeCodesearch(graph, "func_2500");
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(10_000);
		expect(results.length).toBeGreaterThan(0);
	});

	it("should handle non-matching queries efficiently on large graphs", () => {
		const graph = buildSyntheticGraph(5000, 2);

		const t0 = performance.now();
		const results = executeCodesearch(graph, "zzz_nonexistent_xyz");
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(10_000);
		// Should return empty or near-empty results
		for (const r of results) {
			expect(r.sym.name).not.toBe("zzz_nonexistent_xyz");
		}
	});

	it("should respect topN parameter to limit output size", () => {
		const graph = buildSyntheticGraph(5000, 2);

		const results = executeCodesearch(graph, "func", 5);
		expect(results.length).toBeLessThanOrEqual(5);
	});
});

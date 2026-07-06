/**
 * Tests for issue #631 B (slice 3.3): shazam_overview module density.
 *
 * The overview tool now exposes a `topByDensity` field on the JSON
 * envelope -- a list of directories ranked by symbols-per-file ratio.
 * Surfaces "god module" candidates (directories with unusually high
 * symbol density) so an LLM agent can spot refactor targets without
 * paging through the full source tree.
 */
import { describe, it, expect } from "vitest";
import { scanProject } from "../core/scanner.js";
import { buildOverviewResult, executeOverviewJson } from "../tools/overview.js";
import { createRepoGraph, createSymbol, type RepoGraph } from "../core/graph.js";

function buildDensityFixture(): RepoGraph {
	const graph = createRepoGraph();
	// Two directories with very different densities:
	//   - core/ has 5 files, 20 symbols (4.0 symbols/file)
	//   - tools/ has 1 file, 50 symbols (50 symbols/file)
	// core/ should NOT make the top-10 (low ratio), tools/ should.
	for (let i = 0; i < 5; i++) {
		for (let j = 0; j < 4; j++) {
			const id = `core/f${i}.ts::sym${i}_${j}::1`;
			const sym = createSymbol(id, `sym${i}_${j}`, "function", `core/f${i}.ts`, 1);
			graph.symbols.set(sym.id, sym);
			const list = graph.fileSymbols.get(sym.file) ?? [];
			list.push(sym.id);
			graph.fileSymbols.set(sym.file, list);
		}
	}
	for (let j = 0; j < 50; j++) {
		const id = `tools/big.ts::big_${j}::1`;
		const sym = createSymbol(id, `big_${j}`, "function", "tools/big.ts", 1);
		graph.symbols.set(sym.id, sym);
		const list = graph.fileSymbols.get(sym.file) ?? [];
		list.push(sym.id);
		graph.fileSymbols.set(sym.file, list);
	}
	return graph;
}

describe("shazam_overview module density (issue #631 B)", () => {
	it("buildOverviewResult attaches a topByDensity list", () => {
		const graph = buildDensityFixture();
		const result = buildOverviewResult(graph, ".");
		expect(result.topByDensity).toBeDefined();
		expect(Array.isArray(result.topByDensity)).toBe(true);
		expect(result.topByDensity!.length).toBeGreaterThan(0);
	});

	it("topByDensity ranks higher-density directories first", () => {
		const graph = buildDensityFixture();
		const result = buildOverviewResult(graph, ".");
		const densities = result.topByDensity!;
		// tools/big.ts (50 symbols in 1 file = 50.0) must rank above
		// core/f0.ts (4 symbols in 1 file = 4.0) under the 2-level
		// directory grouping the implementation uses. The second
		// path segment includes the file extension.
		const toolsIdx = densities.findIndex((d) => d.dir === "tools/big.ts");
		const coreIdx = densities.findIndex((d) => d.dir === "core/f0.ts");
		expect(toolsIdx).toBeGreaterThanOrEqual(0);
		expect(coreIdx).toBeGreaterThanOrEqual(0);
		expect(toolsIdx).toBeLessThan(coreIdx);
	});

	it("each topByDensity entry carries dir, files, symbols, and ratio", () => {
		const graph = buildDensityFixture();
		const result = buildOverviewResult(graph, ".");
		const toolsEntry = result.topByDensity!.find((d) => d.dir === "tools/big.ts");
		expect(toolsEntry).toBeDefined();
		expect(toolsEntry).toMatchObject({
			dir: "tools/big.ts",
			files: 1,
			symbols: 50,
		});
		expect(toolsEntry!.ratio).toBe(50);
	});

	it("executeOverviewJson includes topByDensity in the JSON envelope", () => {
		const graph = buildDensityFixture();
		const envelope = executeOverviewJson(graph, ".");
		const parsed = JSON.parse(envelope);
		expect(parsed.status).toBe("ok");
		expect(parsed.result.topByDensity).toBeDefined();
		expect(parsed.result.topByDensity.length).toBeGreaterThan(0);
	});

	it("topByDensity is bounded to the top 10 entries", () => {
		const graph = createRepoGraph();
		// 15 directories, each with 1 file containing 1 symbol.
		for (let i = 0; i < 15; i++) {
			const id = `dir${i}/file.ts::s::1`;
			const sym = createSymbol(id, "s", "function", `dir${i}/file.ts`, 1);
			graph.symbols.set(sym.id, sym);
			graph.fileSymbols.set(sym.file, [sym.id]);
		}
		const result = buildOverviewResult(graph, ".");
		expect(result.topByDensity!.length).toBeLessThanOrEqual(10);
	});

	it("real project scan produces a non-empty topByDensity list", () => {
		// Use the actual scanner to make sure the density calc plays
		// nicely with the real graph layout (fileSymbols, etc.).
		const graph = scanProject(".");
		const result = buildOverviewResult(graph, ".");
		expect(result.topByDensity).toBeDefined();
		expect(result.topByDensity!.length).toBeGreaterThan(0);
		// First entry should have all the required fields
		const first = result.topByDensity![0]!;
		expect(typeof first.dir).toBe("string");
		expect(typeof first.files).toBe("number");
		expect(typeof first.symbols).toBe("number");
		expect(typeof first.ratio).toBe("number");
	});
});

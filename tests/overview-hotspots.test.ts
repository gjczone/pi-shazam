/**
 * Regression tests for issue #629 sub-task 1: `shazam_overview` always
 * includes symbol-level Hotspots in both text and JSON output.
 *
 * Before: only file-level `### Complexity Hotspots (Top 10)` appeared. To
 * find risky individual symbols the agent had to call `shazam_impact` on
 * each top file.
 *
 * After: a new `### Hotspots` section is appended with two ranked lists:
 *   - `By PageRank (top 5)` -- raw PageRank, no source-file I/O
 *   - `By complexity (top 5, cyclomatic)` -- source-file regex sweep
 *
 * JSON output gains a `result.hotspots = { byPageRank, byComplexity }`
 * block with stable shape `{ name, file, line, score }` per entry.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepoGraph, createSymbol, type RepoGraph } from "../core/graph.js";
import { executeOverview, executeOverviewJson } from "../tools/overview.js";

/**
 * Build a synthetic graph with 8 symbols. Pagerank is hand-assigned so the
 * expected top-1 is unambiguous. The graph is registered against a real
 * tmp dir because `executeOverviewJson` calls into `topByComplexity`
 * which reads source files (issue #629 spec).
 */
function buildHotspotFixture(rootDir: string): RepoGraph {
	const graph = createRepoGraph();
	const fileA = "src/a.ts";
	const fileB = "src/b.ts";

	// 6 symbols in fileA (mix of low + high PageRank). `endLine` matters
	// for cyclomatic complexity: complexity.ts skips symbols where
	// `endLine <= line` because there is no body slice to count.
	const fileASyms = [
		createSymbol(`${fileA}::hot::1`, "hot", "function", fileA, 1, { endLine: 6, pagerank: 0.42 }),
		createSymbol(`${fileA}::mid::10`, "mid", "function", fileA, 10, { endLine: 14, pagerank: 0.21 }),
		createSymbol(`${fileA}::low::20`, "low", "function", fileA, 20, { endLine: 24, pagerank: 0.05 }),
		createSymbol(`${fileA}::cold::30`, "cold", "function", fileA, 30, { endLine: 32, pagerank: 0.01 }),
		createSymbol(`${fileA}::tiny::40`, "tiny", "function", fileA, 40, { endLine: 41, pagerank: 0.005 }),
		createSymbol(`${fileA}::zero::50`, "zero", "function", fileA, 50, { endLine: 51, pagerank: 0.0 }),
	];
	// 2 in fileB
	const fileBSyms = [
		createSymbol(`${fileB}::other::5`, "other", "function", fileB, 5, { endLine: 6, pagerank: 0.13 }),
		createSymbol(`${fileB}::helper::12`, "helper", "function", fileB, 12, { endLine: 14, pagerank: 0.08 }),
	];

	for (const s of [...fileASyms, ...fileBSyms]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
		const list = graph.nameIndex.get(s.name) ?? [];
		list.push(s);
		graph.nameIndex.set(s.name, list);
	}

	// `hot` covers lines 1..6 (6-line body) with many branches -> high cyclomatic.
	// Ensure the `src/` subdirectory exists -- the tmp root has no nested dirs.
	mkdirSync(join(rootDir, "src"), { recursive: true });
	writeFileSync(
		join(rootDir, fileA),
		[
			"export function hot(x: number) {", // L1
			"  if (x > 0) {", // L2
			"    for (let i = 0; i < x; i++) {", // L3
			"      if (i % 2 === 0 && x > 10) {", // L4
			"        return i;", // L5
			"      }", // L6 (endLine = 6)
			"    }", // L7
			"  } else if (x < 0) {", // L8
			"    return -1;", // L9
			"  }", // L10
			"  return 0;", // L11
			"}", // L12
			"", // L13
			"export function mid() {", // L14 (mid starts)
			"  if (true) return 1;", // L15
			"  return 0;", // L16
			"}", // L17
			"", // L18
			"", // L19
			"export function low() {", // L20 (low starts)
			"  return 1;", // L21
			"}", // L22
			"", // L23
			"", // L24
			"", // L25
			"", // L26
			"", // L27
			"", // L28
			"", // L29
			"export function cold() {", // L30 (cold starts)
			"  return 1;", // L31
			"}", // L32
			"", // L33..L39 (filler)
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"export function tiny() { return 1; }", // L40 (tiny starts; one-liner)
			"", // L41
			"", // L42..L49 (filler)
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"export function zero() { return 0; }", // L50 (zero starts; one-liner)
			"", // L51
		].join("\n"),
	);
	// `other` covers lines 5..6 -- minimal body so cyclomatic score = 1.
	// `helper` covers lines 12..14 with one branch each (if + for).
	writeFileSync(
		join(rootDir, fileB),
		[
			"// helper module", // L1
			"", // L2
			"export const x = 1;", // L3
			"", // L4
			"export function other() {", // L5
			"  return 1;", // L6
			"}", // L7
			"", // L8
			"export const y = 2;", // L9
			"", // L10
			"", // L11
			"export function helper() {", // L12
			"  for (let i = 0; i < 3; i++) {", // L13
			"    if (i > 0) return i;", // L14
			"  }", // L15
			"  return 0;", // L16
			"}", // L17
		].join("\n"),
	);

	return graph;
}

describe("issue #629 / 1: shazam_overview includes Hotspots section", () => {
	let tmp = "";
	let graph: RepoGraph = createRepoGraph();

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "overview-hotspots-"));
		graph = buildHotspotFixture(tmp);
	});

	afterAll(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it("text output contains the new ### Hotspots section with both subsections", () => {
		const text = executeOverview(graph, tmp);
		expect(text).toContain("### Hotspots");
		expect(text).toContain("By PageRank");
		expect(text).toContain("By complexity");
	});

	it("text output ranks the highest-PageRank symbol first in By PageRank", () => {
		const text = executeOverview(graph, tmp);
		// `hot` has the highest pagerank (0.42) -- should appear as #1.
		const byRankIdx = text.indexOf("By PageRank");
		const section = text.slice(byRankIdx);
		expect(section).toMatch(/1\. `src\/a\.ts`::hot \(0\.42\)/);
	});

	it("text output preserves both new section and existing file-level hotspots", () => {
		// #629: both sections coexist with distinct titles -- the old
		// `### Complexity Hotspots (Top 10)` (file-level) and the new
		// `### Hotspots` (symbol-level) must both appear.
		const text = executeOverview(graph, tmp);
		expect(text).toContain("### Complexity Hotspots (Top 10)");
		expect(text).toContain("### Hotspots");
	});

	it("JSON output includes a hotspots block with byPageRank and byComplexity", () => {
		const envelope = JSON.parse(executeOverviewJson(graph, tmp));
		expect(envelope.status).toBe("ok");
		expect(envelope.result).toBeDefined();
		const hotspots = envelope.result.hotspots;
		expect(hotspots).toBeDefined();
		expect(Array.isArray(hotspots.byPageRank)).toBe(true);
		expect(Array.isArray(hotspots.byComplexity)).toBe(true);
	});

	it("JSON hotspots.byPageRank caps at HOTSPOTS_TOP_N (5) entries", () => {
		const envelope = JSON.parse(executeOverviewJson(graph, tmp));
		// Fixture has 8 symbols -- the cap is 5 so we must see exactly 5.
		expect(envelope.result.hotspots.byPageRank.length).toBe(5);
	});

	it("each JSON hotspots entry has { name, file, line, score } shape", () => {
		const envelope = JSON.parse(executeOverviewJson(graph, tmp));
		for (const entry of envelope.result.hotspots.byPageRank) {
			expect(entry).toHaveProperty("name");
			expect(entry).toHaveProperty("file");
			expect(entry).toHaveProperty("line");
			expect(entry).toHaveProperty("score");
			expect(typeof entry.name).toBe("string");
			expect(typeof entry.file).toBe("string");
			expect(typeof entry.line).toBe("number");
			expect(typeof entry.score).toBe("number");
		}
	});

	it("JSON hotspots.byComplexity gives `hot` the highest cyclomatic score", () => {
		const envelope = JSON.parse(executeOverviewJson(graph, tmp));
		const byComplexity = envelope.result.hotspots.byComplexity;
		expect(byComplexity.length).toBeGreaterThan(0);
		// `hot` body has multiple `if` + `for` + `&&` matches -> must be on top.
		expect(byComplexity[0].name).toBe("hot");
		// `hot` score > 1 (baseline) because its body has branching tokens.
		expect(byComplexity[0].score).toBeGreaterThan(1);
	});

	it("filtered overview omits hotspots (they're project-wide, not scope-wide)", () => {
		const envelope = JSON.parse(executeOverviewJson(graph, tmp, "a"));
		expect(envelope.result.hotspots).toBeUndefined();
	});
});

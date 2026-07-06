/**
 * Regression tests for issue #635: unified Affected Tests detection
 * across `shazam_impact --files` and `shazam_impact --symbol` modes.
 *
 * Before this fix the "Affected Tests (must re-run)" section only appeared
 * in file mode; symbol mode silently omitted it. The fix centralises the
 * four test-pattern predicates in `core/test-patterns.ts` and shares the
 * formatting helper between both code paths.
 *
 * These tests build synthetic RepoGraph fixtures by hand so they are
 * independent of the project's default `tests/`-exclusion behaviour
 * (see issue #632). The behaviour under test is the dispatcher's
 * helper choice, not the scanner's coverage.
 */
import { describe, it, expect } from "vitest";
import { executeImpact, executeImpactJson, executeCallChain, executeCallChainJson } from "../tools/impact.js";
import { isTestFile, filterTestFiles } from "../core/test-patterns.js";
import { createRepoGraph, createSymbol, createEdge, type RepoGraph } from "../core/graph.js";

/**
 * Build a minimal graph:
 *
 *   tests/foo.test.ts --calls--> src/scanner.ts::scanProject
 *                                       |
 *                                       v
 *                                src/internal.ts::doWork
 *
 * The "Affected Tests" detection must surface `tests/foo.test.ts`
 * when we trace the call chain starting from `scanProject`.
 */
function buildCallChainFixture(): RepoGraph {
	const graph = createRepoGraph();

	const sym = (id: string, name: string, kind: string, file: string, line: number) =>
		createSymbol(id, name, kind, file, line);

	const scanProject = sym("src/scanner.ts::scanProject::10", "scanProject", "function", "src/scanner.ts", 10);
	const doWork = sym("src/internal.ts::doWork::20", "doWork", "function", "src/internal.ts", 20);
	const testHelper = sym("tests/foo.test.ts::testScan::5", "testScan", "function", "tests/foo.test.ts", 5);

	for (const s of [scanProject, doWork, testHelper]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
		const list = graph.nameIndex.get(s.name) ?? [];
		list.push(s);
		graph.nameIndex.set(s.name, list);
	}

	// testHelper --calls--> scanProject --calls--> doWork
	const edge1 = createEdge(testHelper.id, scanProject.id, 1.0, "call");
	const edge2 = createEdge(scanProject.id, doWork.id, 1.0, "call");
	graph.outgoing.set(testHelper.id, [edge1]);
	graph.outgoing.set(scanProject.id, [edge2]);
	graph.incoming.set(scanProject.id, [edge1]);
	graph.incoming.set(doWork.id, [edge2]);

	return graph;
}

/** Same fixture plus an extra test file that depends on `doWork` via import. */
function buildFileImpactFixture(): RepoGraph {
	const graph = buildCallChainFixture();

	const sym = (id: string, name: string, kind: string, file: string, line: number) =>
		createSymbol(id, name, kind, file, line);

	const helper = sym("src/helpers.ts::helper::1", "helper", "function", "src/helpers.ts", 1);
	const helperTest = sym("tests/helpers.test.ts::testHelper::3", "testHelper", "function", "tests/helpers.test.ts", 3);

	for (const s of [helper, helperTest]) {
		graph.symbols.set(s.id, s);
		graph.fileSymbols.set(s.file, [...(graph.fileSymbols.get(s.file) ?? []), s.id]);
		const list = graph.nameIndex.get(s.name) ?? [];
		list.push(s);
		graph.nameIndex.set(s.name, list);
	}

	// helperTest --calls--> helper
	const edge = createEdge(helperTest.id, helper.id, 1.0, "call");
	graph.outgoing.set(helperTest.id, [edge]);
	graph.incoming.set(helper.id, [edge]);

	return graph;
}

// ------------------------------------------------------------------
// Pure-function tests for core/test-patterns.ts
// ------------------------------------------------------------------

describe("isTestFile (core/test-patterns.ts)", () => {
	it("matches .test. pattern", () => {
		expect(isTestFile("src/foo.test.ts")).toBe(true);
		expect(isTestFile("tests/impact-affected-tests.test.ts")).toBe(true);
	});

	it("matches .spec. pattern", () => {
		expect(isTestFile("src/foo.spec.ts")).toBe(true);
	});

	it("matches __tests__ directory", () => {
		expect(isTestFile("src/__tests__/foo.ts")).toBe(true);
		expect(isTestFile("__tests__/foo.ts")).toBe(true);
	});

	it("matches tests/ prefix", () => {
		expect(isTestFile("tests/foo.ts")).toBe(true);
		expect(isTestFile("tests/integration/setup.ts")).toBe(true);
	});

	it("does not match production source files", () => {
		expect(isTestFile("src/foo.ts")).toBe(false);
		expect(isTestFile("core/scanner.ts")).toBe(false);
		expect(isTestFile("tools/impact.ts")).toBe(false);
		expect(isTestFile("index.ts")).toBe(false);
	});

	it("does not match test-adjacent but non-test files", () => {
		// "test" without the dot separator is NOT a test file
		expect(isTestFile("src/testing-utils.ts")).toBe(false);
		expect(isTestFile("src/specification.ts")).toBe(false);
	});
});

describe("filterTestFiles (core/test-patterns.ts)", () => {
	it("partitions paths preserving input order", () => {
		const input = ["src/a.ts", "tests/a.test.ts", "src/b.ts", "tests/b.test.ts"];
		const { tests, nonTests } = filterTestFiles(input);
		expect(tests).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
		expect(nonTests).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("returns empty buckets for empty input", () => {
		const { tests, nonTests } = filterTestFiles([]);
		expect(tests).toEqual([]);
		expect(nonTests).toEqual([]);
	});
});

// ------------------------------------------------------------------
// End-to-end: `shazam_impact --files` mode surfaces Affected Tests
// ------------------------------------------------------------------

describe("shazam_impact --files mode surfaces Affected Tests (#635)", () => {
	it("includes the section when test files are in the affected set", () => {
		// BFS from src/helpers.ts reaches tests/helpers.test.ts because the
		// test calls helper. Output must include the Affected Tests section.
		const graph = buildFileImpactFixture();
		const output = executeImpact(graph, ["src/helpers.ts"]);

		expect(output).toContain("### Affected Tests (must re-run)");
		expect(output).toContain("`tests/helpers.test.ts`");
	});
});

// ------------------------------------------------------------------
// End-to-end: `shazam_impact --symbol` mode NOW surfaces Affected Tests
// (the bug fix — previously missing entirely)
// ------------------------------------------------------------------

describe("shazam_impact --symbol mode surfaces Affected Tests (#635)", () => {
	it("includes 'Affected Tests (must re-run)' when the call chain touches a test file", () => {
		// Call chain for `scanProject` traces back to tests/foo.test.ts
		// (which calls scanProject) — the symbol-mode output must list it.
		const graph = buildCallChainFixture();
		const output = executeCallChain(graph, "scanProject", 3, "both");

		expect(output).toContain("### Affected Tests (must re-run)");
		expect(output).toContain("`tests/foo.test.ts`");
	});

	it("includes the section for downstream test callers", () => {
		// `helper` has tests/helpers.test.ts calling it.
		const graph = buildFileImpactFixture();
		const output = executeCallChain(graph, "helper", 2, "both");

		expect(output).toContain("### Affected Tests (must re-run)");
		expect(output).toContain("`tests/helpers.test.ts`");
	});

	it("symbol-mode JSON output includes affectedTests array per target", () => {
		const graph = buildCallChainFixture();
		const jsonStr = executeCallChainJson(graph, "scanProject", 3, "both");
		const parsed = JSON.parse(jsonStr);

		expect(Array.isArray(parsed.result)).toBe(true);
		expect(parsed.result.length).toBeGreaterThan(0);

		for (const entry of parsed.result) {
			expect(entry).toHaveProperty("affectedTests");
			expect(Array.isArray(entry.affectedTests)).toBe(true);
		}

		const totalTests = parsed.result.reduce(
			(sum: number, e: { affectedTests: string[] }) => sum + e.affectedTests.length,
			0,
		);
		expect(totalTests).toBeGreaterThan(0);
	});

	it("JSON affectedTests entries all pass the isTestFile predicate", () => {
		const graph = buildCallChainFixture();
		const jsonStr = executeCallChainJson(graph, "scanProject", 3, "both");
		const parsed = JSON.parse(jsonStr);

		const allTests: string[] = parsed.result.flatMap((e: { affectedTests: string[] }) => e.affectedTests);
		for (const f of allTests) {
			expect(isTestFile(f)).toBe(true);
		}
	});

	it("returns Symbol not found without emitting an Affected Tests section", () => {
		const graph = buildCallChainFixture();
		const output = executeCallChain(graph, "doesNotExist", 3, "both");
		expect(output).toBe("Symbol not found: doesNotExist");
	});
});

// ------------------------------------------------------------------
// Mode independence — both modes use the SAME predicates
// ------------------------------------------------------------------

describe("Affected Tests detection is identical across modes", () => {
	it("every path listed in symbol-mode affectedTests passes isTestFile (file-mode predicate)", () => {
		const graph = buildCallChainFixture();
		const jsonStr = executeCallChainJson(graph, "scanProject", 3, "both");
		const parsed = JSON.parse(jsonStr);

		const symbolTests: string[] = parsed.result.flatMap((e: { affectedTests: string[] }) => e.affectedTests);
		for (const f of symbolTests) {
			expect(isTestFile(f)).toBe(true);
		}
	});
});

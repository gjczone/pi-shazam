/**
 * Tests for scanner default-excludes-tests behavior (issue #632).
 *
 * Background: tests/ files used to pollute the main source graph. ~56% of
 * pi-shazam's own source files are test files; their presence meant LLM
 * agents had to disambiguate real symbols from test mocks in
 * shazam_lookup, shazam_impact, and shazam_overview output.
 *
 * Default policy: scanner excludes files matching `isTestFile()`
 * (defined in core/filter.ts). Opt-in: pass `includeTests: true` or
 * set `PI_SHAZAM_INCLUDE_TESTS=1`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scanProject, resetCache, getExcludedTestCount } from "../core/scanner.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "os";

// Snapshot PI_SHAZAM_INCLUDE_TESTS so tests don't leak env state into
// each other. Restored in afterEach.
const ORIGINAL_ENV = process.env.PI_SHAZAM_INCLUDE_TESTS;

function createFixture(): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-exclude-"));

	// 3 production files
	writeFileSync(
		join(tmpDir, "app.ts"),
		`export function prod_one(): number { return 1; }
export function prod_two(): number { return 2; }
export function prod_three(): number { return 3; }
`,
	);
	writeFileSync(
		join(tmpDir, "math.ts"),
		`export function add(a: number, b: number): number { return a + b; }
export function mul(a: number, b: number): number { return a * b; }
`,
	);
	writeFileSync(
		join(tmpDir, "utils.ts"),
		`export function fmt(n: number): string { return String(n); }
`,
	);

	// 3 test files (should be excluded by default, included with opt-in)
	writeFileSync(
		join(tmpDir, "app.test.ts"),
		`export function test_app_helper(): number { return 99; }
`,
	);
	writeFileSync(
		join(tmpDir, "math.test.ts"),
		`export function test_math_helper(): number { return 88; }
`,
	);
	mkdirSync(join(tmpDir, "tests"));
	writeFileSync(
		join(tmpDir, "tests", "smoke.test.ts"),
		`export function test_smoke_helper(): number { return 77; }
`,
	);

	return tmpDir;
}

describe("scanProject test exclusion (issue #632)", () => {
	let projectRoot: string;

	beforeEach(() => {
		resetCache();
		projectRoot = createFixture();
		// Explicitly clear the env var so each test runs against the default
		// policy unless it opts in. Restore the snapshot in afterEach.
		delete process.env.PI_SHAZAM_INCLUDE_TESTS;
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
		resetCache();
		if (ORIGINAL_ENV === undefined) {
			delete process.env.PI_SHAZAM_INCLUDE_TESTS;
		} else {
			process.env.PI_SHAZAM_INCLUDE_TESTS = ORIGINAL_ENV;
		}
	});

	it("default scan does NOT emit console.warn when tests are excluded (issue #632 UX)", () => {
		// The "Excluded N test files from graph" notice is policy information,
		// not a failure. It must be surfaced to the agent via the overview's
		// system-prompt injection (core/overview.ts), NOT via console.warn.
		// A stderr line on every Pi startup is noise that the user does not
		// need to see.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			scanProject(projectRoot);
			const calls = warnSpy.mock.calls.map((c) => c.join(" "));
			const offending = calls.find((m) => /Excluded \d+ test files/i.test(m));
			expect(offending, `unexpected console.warn: ${JSON.stringify(offending)}`).toBeUndefined();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("default scan excludes test files (3 production files only)", () => {
		const graph = scanProject(projectRoot);
		const files = [...graph.fileSymbols.keys()].sort();
		expect(files).toEqual(["app.ts", "math.ts", "utils.ts"]);
		// Test-file symbols must NOT be in the graph
		const testHelper = [...graph.symbols.values()].find((s) => s.name === "test_app_helper");
		expect(testHelper).toBeUndefined();
		const testSmoke = [...graph.symbols.values()].find((s) => s.name === "test_smoke_helper");
		expect(testSmoke).toBeUndefined();
	});

	it("scanProject with includeTests=true includes test files (6 files)", () => {
		const graph = scanProject(projectRoot, undefined, { includeTests: true });
		const files = [...graph.fileSymbols.keys()]
			.map((f) => f.split(/[\\/]/).join("/")) // normalize to POSIX for cross-platform assertions
			.sort();
		expect(files).toEqual(["app.test.ts", "app.ts", "math.test.ts", "math.ts", "tests/smoke.test.ts", "utils.ts"]);
		// Production symbols are present
		expect([...graph.symbols.values()].find((s) => s.name === "prod_one")).toBeDefined();
		// Test-file symbols are also present
		expect([...graph.symbols.values()].find((s) => s.name === "test_app_helper")).toBeDefined();
		expect([...graph.symbols.values()].find((s) => s.name === "test_smoke_helper")).toBeDefined();
	});

	it("__tests__/foo.test.ts is excluded by default", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-underscore-tests-"));
		try {
			writeFileSync(join(tmpDir, "bar.ts"), "export function real(): number { return 1; }\n");
			mkdirSync(join(tmpDir, "__tests__"));
			writeFileSync(join(tmpDir, "__tests__", "foo.test.ts"), "export function fake(): number { return 9; }\n");

			const graph = scanProject(tmpDir);
			const files = [...graph.fileSymbols.keys()].sort();
			expect(files).toEqual(["bar.ts"]);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("PI_SHAZAM_INCLUDE_TESTS=1 environment variable opts in to test inclusion", () => {
		process.env.PI_SHAZAM_INCLUDE_TESTS = "1";
		const graph = scanProject(projectRoot);
		const files = [...graph.fileSymbols.keys()].map((f) => f.split(/[\\/]/).join("/"));
		// Should include test files because env var is set (paths normalized for cross-platform)
		expect(files).toContain("app.test.ts");
		expect(files).toContain("tests/smoke.test.ts");
	});

	it("getExcludedTestCount returns the count tied to the specific graph", () => {
		// Two scans in the same process (no resetCache); each graph must carry
		// its own count without cross-contamination. Catches the prior module-level
		// state bug where the count leaked across cache hits (issue #632 diff review).
		const g1 = scanProject(projectRoot);
		const c1 = getExcludedTestCount(g1);
		// g1 from this fixture had 3 test files (app.test.ts + math.test.ts + tests/smoke.test.ts)
		expect(c1).toBe(3);

		// A different graph (from a fixture with no test files at all) should
		// report 0 -- proving the count is per-graph, not a stale global.
		const noTestsDir = (() => {
			const dir = mkdtempSync(join(tmpdir(), "pi-shazam-no-tests-"));
			writeFileSync(join(dir, "only.ts"), "export const x = 1;\n");
			return dir;
		})();
		try {
			const g2 = scanProject(noTestsDir);
			expect(getExcludedTestCount(g2)).toBe(0);
			// g1's count is untouched by the second scan
			expect(getExcludedTestCount(g1)).toBe(3);
		} finally {
			rmSync(noTestsDir, { recursive: true, force: true });
		}
	});

	it("overview text mode and JSON mode both surface excluded test count (REVIEW-RULES P1 #13)", async () => {
		// Uses the real pi-shazam project (~68 test files); default scanProject
		// returns a graph with excludedTestCount > 0. Both text and JSON
		// output modes MUST carry the same signal -- otherwise JSON-only LLM
		// consumers silently lose the section (issue #632 + REVIEW-RULES P1 #13).
		resetCache();
		delete process.env.PI_SHAZAM_INCLUDE_TESTS;
		const graph = scanProject(process.cwd());
		const excluded = getExcludedTestCount(graph);
		expect(excluded).toBeGreaterThan(0);

		const { executeOverview, executeOverviewJson } = await import("../tools/overview.js");
		const text = executeOverview(graph, process.cwd());
		expect(text).toContain("test file(s) excluded");
		expect(text).toContain("PI_SHAZAM_INCLUDE_TESTS=1");

		const jsonText = executeOverviewJson(graph, process.cwd());
		const parsed = JSON.parse(jsonText);
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBeDefined();
		expect(parsed.result.excludedTests).toBe(excluded);
	});

	it("overview JSON omits excludedTests when none were filtered (zero is invisible)", async () => {
		// When includeTests is used or no test files exist, the JSON payload
		// must NOT advertise excludedTests (undefined/null vs 0 ambiguity).
		process.env.PI_SHAZAM_INCLUDE_TESTS = "1";
		try {
			const graph = scanProject(projectRoot);
			const { executeOverviewJson } = await import("../tools/overview.js");
			const jsonText = executeOverviewJson(graph, projectRoot);
			const parsed = JSON.parse(jsonText);
			// Field should be absent (not 0) to keep the JSON minimal
			expect(parsed.result.excludedTests).toBeUndefined();
		} finally {
			delete process.env.PI_SHAZAM_INCLUDE_TESTS;
		}
	});
});

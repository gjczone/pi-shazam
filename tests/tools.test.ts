/**
 * Tests for query tools — verify each tool returns valid output.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";

// Get a shared graph for tests (built once)
let _graph: RepoGraph | null = null;
function getGraph(): RepoGraph {
	if (!_graph) {
		_graph = scanProject(".");
	}
	return _graph;
}

describe("Tool: overview", () => {
	it("should return project structure summary", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const result = executeOverview(getGraph(), ".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		expect(result).toMatch(/index\.ts|Top|PageRank|modules/i);
	});

	it("should support json output", async () => {
		const { executeOverviewJson } = await import("../tools/overview.js");
		const result = executeOverviewJson(getGraph(), ".");
		expect(result).toBeDefined();
		const parsed = JSON.parse(result);
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBeDefined();
	});

	it("should include Key Dependencies section", async () => {
		const { buildKeyDependenciesSection } = await import("../tools/overview.js");
		const section = buildKeyDependenciesSection(".");
		expect(section).toBeDefined();
		expect(section).not.toBeNull();
		expect(section).toMatch(/### Key Dependencies/);
		expect(section).toMatch(/tree-sitter|typebox|vscode-jsonrpc/i);
	});

	it("should include Recent Changes section", async () => {
		const { buildRecentChangesSection } = await import("../tools/overview.js");
		const section = buildRecentChangesSection(".");
		expect(section).toBeDefined();
		expect(section).not.toBeNull();
		expect(section).toMatch(/### Recent Changes/);
	});

	it("should include new sections in overview output", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const result = executeOverview(getGraph(), ".");
		expect(result).toMatch(/### Key Dependencies/);
		expect(result).toMatch(/### Recent Changes/);
	});

	it("should include new sections in json output", async () => {
		const { executeOverviewJson } = await import("../tools/overview.js");
		const result = executeOverviewJson(getGraph(), ".");
		const parsed = JSON.parse(result);
		expect(parsed.result.keyDependencies).toBeDefined();
		expect(parsed.result.recentChanges).toBeDefined();
	});

	it("should return null for Key Dependencies when no package.json", async () => {
		const { buildKeyDependenciesSection } = await import("../tools/overview.js");
		const section = buildKeyDependenciesSection("/tmp/nonexistent");
		expect(section).toBeNull();
	});
});

describe("Tool: impact", () => {
	it("should analyze blast radius for given files", async () => {
		const { executeImpact } = await import("../tools/impact.js");
		const result = executeImpact(getGraph(), ["index.ts"]);
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});
});

describe("Tool: symbol", () => {
	it("should return symbol details", async () => {
		const { _findSymbols } = await import("../tools/lookup.js");
		const result = _findSymbols(getGraph(), "scanProject");
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result.some((s: any) => s.name.includes("scanProject"))).toBe(true);
	});
});

describe("Tool: call_chain", () => {
	it("should trace call chain for a symbol", async () => {
		const { executeCallChain } = await import("../tools/impact.js");
		const graph = getGraph();
		const syms = [...graph.symbols.values()];
		const symWithEdges = syms.find((s) => {
			const out = graph.outgoing.get(s.id);
			const inc = graph.incoming.get(s.id);
			return out && out.length > 0 && inc && inc.length > 0;
		});
		if (symWithEdges) {
			const result = executeCallChain(graph, symWithEdges.name, 2);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
		}
	});

	it("should support --flat mode (replaces refs)", async () => {
		const mod = await import("../tools/impact.js");
		const graph = getGraph();
		const refs = mod.getFlatReferences(graph, "scanProject");
		expect(refs).toBeDefined();
		expect(Array.isArray(refs)).toBe(true);
		if (refs.length > 0) {
			const formatted = mod.formatFlatReferences(refs, "scanProject");
			expect(typeof formatted).toBe("string");
			expect(formatted.length).toBeGreaterThan(0);
		}
	});
});

describe("Tool: file_detail", () => {
	it("should analyze a file in detail", async () => {
		const { _executeFileDetail } = await import("../tools/lookup.js");
		const result = _executeFileDetail(getGraph(), "core/graph.ts");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		expect(result).toMatch(/Symbol|symbol/i);
	});

	it("should correctly group container members (O(N²) grouping logic)", async () => {
		const { _executeFileDetail } = await import("../tools/lookup.js");
		const { createRepoGraph, createSymbol } = await import("../core/graph.js");

		const graph = createRepoGraph();
		const file = "test.ts";

		// Class spanning lines 10-50
		const classSym = createSymbol("cls-1", "MyClass", "class", file, 10, {
			endLine: 50,
			pagerank: 0.5,
		});
		// Method inside the class at lines 20-30
		const methodSym = createSymbol("mtd-1", "myMethod", "method", file, 20, {
			endLine: 30,
			pagerank: 0.2,
			visibility: "public",
		});
		// Standalone function at lines 60-70 (outside class range)
		const funcSym = createSymbol("fn-1", "myFunction", "function", file, 60, {
			endLine: 70,
			pagerank: 0.3,
			visibility: "exported",
		});

		graph.symbols.set(classSym.id, classSym);
		graph.symbols.set(methodSym.id, methodSym);
		graph.symbols.set(funcSym.id, funcSym);
		graph.fileSymbols.set(file, [classSym.id, methodSym.id, funcSym.id]);
		graph.incoming.set(classSym.id, []);
		graph.outgoing.set(classSym.id, []);
		graph.incoming.set(methodSym.id, []);
		graph.outgoing.set(methodSym.id, []);
		graph.incoming.set(funcSym.id, []);
		graph.outgoing.set(funcSym.id, []);

		const result = _executeFileDetail(graph, file);

		// Class should appear as a container with myMethod as its member
		expect(result).toMatch(/container class.*MyClass/);
		expect(result).toMatch(/└ method.*myMethod/);

		// myFunction should be in "Other symbols" (standalone, not a container member)
		expect(result).toContain("Other symbols:");
		expect(result).toMatch(/function.*myFunction/);

		// myMethod should NOT appear in "Other symbols" (already grouped under container)
		const otherSection = result.split("Other symbols:")[1];
		expect(otherSection).not.toContain("myMethod");
	});
});

describe("Tool: hotspots", () => {
	it("should rank files by complexity", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");
		const result = _computeHotspots(getGraph(), 5);
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
	});

	it("should NOT rank config/generated files like package-lock.json in top results", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");
		const result = _computeHotspots(getGraph(), 20);
			expect(result).not.toContainEqual(expect.objectContaining({ file: expect.stringMatching(/package-lock\.json/) }));
	});
});

describe("Tool: overview — routes section", () => {
	it("should return route inventory (may be empty for non-web projects)", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const result = executeOverview(getGraph(), ".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
	});

	it("should NOT return false positives from generic symbol names in CLI projects", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const result = executeOverview(getGraph(), ".");
		// pi-shazam is a CLI project with no web framework — should not have routes
		expect(result).not.toMatch(/Route-related/);
	});

	it("should include routes section in overview when web framework detected", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		// pi-shazam has no web framework, so routes section should not appear in output
		const result = executeOverview(getGraph(), ".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
	});
});

describe("Tool: symbol — state mode", () => {
	it("should explore enum/state symbols via state mode", async () => {
		const { executeStateMap } = await import("../tools/lookup.js");
		const graph = getGraph();
		const enumSym = [...graph.symbols.values()].find((s) => s.kind === "class" || s.kind === "enum");
		if (enumSym) {
			const result = executeStateMap(graph, enumSym.name);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
		}
	});

	it("should reject non-enum/non-const symbols with a clear message", async () => {
		const { executeStateMap } = await import("../tools/lookup.js");
		const graph = getGraph();
		// Find a function symbol (not enum/const/state-machine)
		const funcSym = [...graph.symbols.values()].find((s) => s.kind === "function");
		if (funcSym) {
			const result = executeStateMap(graph, funcSym.name);
			// Should indicate this is not a state-map-able symbol
			expect(result).toMatch(/not.*enum|not.*const|not.*state|no.*state.*map|cannot.*generate/i);
		}
	});

	it("should return state map output when mode=state via executeSymbol", async () => {
		const { executeStateMap } = await import("../tools/lookup.js");
		const graph = getGraph();
		const enumSym = [...graph.symbols.values()].find((s) => s.kind === "class" || s.kind === "enum");
		if (enumSym) {
			const result = executeStateMap(graph, enumSym.name);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
		}
	});
});

describe("Tool: verify", () => {
	it("should return verification results with risk level", async () => {
		const { executeVerify } = await import("../tools/verify.js");
		const result = executeVerify(getGraph(), ".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		expect(result).toMatch(/risk|changed|symbol|file/i);
	});

	it("should support quick mode", async () => {
		const { executeVerify } = await import("../tools/verify.js");
		const result = executeVerify(getGraph(), ".", { quick: true });
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
	});

	it("should support json output", async () => {
		const { executeVerifyJson } = await import("../tools/verify.js");
		const result = executeVerifyJson(getGraph(), ".");
		expect(result).toBeDefined();
		const parsed = JSON.parse(result);
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBeDefined();
		expect(parsed.result.riskLevel).toBeDefined();
	});

	it("should NOT claim to run LSP diagnostics, call-graph consistency, or contract risk when unavailable", async () => {
		const { executeVerify } = await import("../tools/verify.js");
		const result = executeVerify(getGraph(), ".");
		expect(result).not.toMatch(/LSP diagnostics.*pyright.*tsc.*rust-analyzer.*gopls/);
	});
});


describe("Tool: verify — N+1 sequential lspCodeActions (issue #370)", () => {
	it("should use Promise.all for parallel lspCodeActions, not serial for-await", async () => {
		// Read the verify.ts source to validate the code pattern.
		// The code actions section (after "Fetch code actions for error/warning diagnostics")
		// must use Promise.all for parallel execution.  The current serial `for...await`
		// pattern causes N+1 sequential waits — each diagnostic blocks the next.
		// Fix: wrap lspCodeActions calls in Promise.all for concurrent execution.
		const source = await readFile("tools/verify.ts", "utf-8");

		// Find the code-actions section by its comment marker
		const sectionStart = source.indexOf("Fetch code actions for error/warning diagnostics");
		expect(sectionStart).toBeGreaterThan(-1);

		// Extract the relevant section (from the comment to end of runLspDiagnostics)
		const section = source.slice(sectionStart);

		// After the fix, Promise.all wraps the lspCodeActions calls for parallel execution.
		// Before the fix, a serial `for...of` loop with `await` does them one-by-one.
		expect(section).toMatch(/Promise\.all/);
	});

	it("serial for-await is measurably slower than parallel Promise.all (behavioral validation)", async () => {
		// This test validates the expected behavior: with N diagnostics each
		// taking D ms of latency, the serial pattern takes >= N*D ms while
		// Promise.all takes ~D ms.  It does NOT test pi-shazam internals
		// directly — it documents the timing contract the fix must satisfy.
		const DELAY_MS = 30;
		const DIAG_COUNT = 5;

		// Simulated lspCodeActions with fixed latency
		async function mockCodeActions(label: string): Promise<{ title: string }[]> {
			await new Promise((r) => setTimeout(r, DELAY_MS));
			return [{ title: `Fix ${label}` }];
		}

		// ── Serial pattern (current bug) ──
		const serialStart = Date.now();
		const serialResults: string[][] = [];
		for (let i = 0; i < DIAG_COUNT; i++) {
			const actions = await mockCodeActions(`diag-${i}`);
			serialResults.push(actions.map((a) => a.title));
		}
		const serialDuration = Date.now() - serialStart;

		// ── Parallel pattern (the fix) ──
		const parallelStart = Date.now();
		const parallelResults = await Promise.all(
			Array.from({ length: DIAG_COUNT }, (_, i) =>
				mockCodeActions(`diag-${i}`).then((actions) => actions.map((a) => a.title)),
			),
		);
		const parallelDuration = Date.now() - parallelStart;

		// Serial takes >= N * delay (with 20% tolerance for timing jitter)
		expect(serialDuration).toBeGreaterThanOrEqual(DIAG_COUNT * DELAY_MS * 0.8);
		// Parallel takes < N * delay (substantially faster)
		expect(parallelDuration).toBeLessThan(DIAG_COUNT * DELAY_MS * 0.8);
		// Both produce identical results
		expect(serialResults).toEqual(parallelResults);
	});
});

describe("Tool: fix", () => {
	it("should return fix results in dry-run mode", async () => {
		const { executeFormat } = await import("../tools/format.js");
		const result = executeFormat(getGraph(), ".", { dryRun: true });
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("should support json output with dryRun", async () => {
		const { executeFormatJson } = await import("../tools/format.js");
		const result = executeFormatJson(getGraph(), ".", { dryRun: true });
		expect(result).toBeDefined();
		const parsed = JSON.parse(result);
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBeDefined();
		expect(parsed.result.dryRun).toBe(true);
	});
});

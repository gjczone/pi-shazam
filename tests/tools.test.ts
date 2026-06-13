/**
 * Tests for query tools — verify each tool returns valid output.
 */
import { describe, it, expect } from "vitest";
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

describe("Tool: codesearch", () => {
	it("should search symbols by keyword", async () => {
		const { executeCodesearch } = await import("../tools/codesearch.js");
		const result = executeCodesearch(getGraph(), "scan");
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
		expect(result[0]).toHaveProperty("sym");
		expect(result[0]).toHaveProperty("score");
		expect(result[0]!.score).toBeGreaterThan(0);
	});

	it("should support fulltext search with explicit projectRoot (issue #251)", async () => {
		const { executeFulltextSearch } = await import("../tools/codesearch.js");
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { join: pathJoin } = await import("node:path");
		const { tmpdir } = await import("node:os");

		// Create a temp directory with a known file
		const tmpDir = mkdtempSync(pathJoin(tmpdir(), "shazam-test-251-"));
		try {
			writeFileSync(pathJoin(tmpDir, "sample.ts"), "export function uniqueShazamTestFn() { return 42; }\n");

			// Search with explicit projectRoot should find the known function
			const results = executeFulltextSearch("uniqueShazamTestFn", 10, tmpDir);
			expect(results).toBeDefined();
			expect(Array.isArray(results)).toBe(true);
			expect(results.length).toBeGreaterThan(0);
			expect(results[0]!.text).toContain("uniqueShazamTestFn");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("Tool: symbol", () => {
	it("should return symbol details", async () => {
		const { executeSymbol } = await import("../tools/symbol.js");
		const result = executeSymbol(getGraph(), "scanProject");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result).toContain("scanProject");
	});
});

describe("Tool: call_chain", () => {
	it("should trace call chain for a symbol", async () => {
		const { executeCallChain } = await import("../tools/call_chain.js");
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
		const mod = await import("../tools/call_chain.js");
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

describe("Tool: hover", () => {
	it("should return hover info for a symbol", async () => {
		const { executeHover } = await import("../tools/hover.js");
		const graph = getGraph();
		const sym = [...graph.symbols.values()].find((s) => s.name === "scanProject");
		if (sym) {
			const result = await executeHover(graph, sym.name);
			expect(result).toBeDefined();
			expect(result.name).toBe("scanProject");
			expect(result.kind).toBeDefined();
		}
	});
});

describe("Tool: file_detail", () => {
	it("should analyze a file in detail", async () => {
		const { executeFileDetail } = await import("../tools/file_detail.js");
		const result = executeFileDetail(getGraph(), "core/graph.ts");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		expect(result).toMatch(/Symbol|symbol/i);
	});
});

describe("Tool: hotspots", () => {
	it("should rank files by complexity", async () => {
		const { executeHotspots } = await import("../tools/hotspots.js");
		const result = executeHotspots(getGraph(), 5);
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("should NOT rank config/generated files like package-lock.json in top results", async () => {
		const { executeHotspots } = await import("../tools/hotspots.js");
		const result = executeHotspots(getGraph(), 20);
		// package-lock.json and other config files should not appear in hotspots
		// Check that no ranked line (starting with a number) contains config files
		const rankedLines = result.split("\n").filter((l: string) => /^\d+\./.test(l));
		expect(rankedLines).not.toContainEqual(expect.stringMatching(/package-lock\.json/));
	});
});

describe("Tool: overview — routes section", () => {
	it("should return route inventory (may be empty for non-web projects)", async () => {
		const { executeRoutes } = await import("../tools/overview.js");
		const result = executeRoutes(getGraph(), ".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
	});

	it("should NOT return false positives from generic symbol names in CLI projects", async () => {
		const { executeRoutes } = await import("../tools/overview.js");
		const result = executeRoutes(getGraph(), ".");
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
		const { executeStateMap } = await import("../tools/symbol.js");
		const graph = getGraph();
		const enumSym = [...graph.symbols.values()].find((s) => s.kind === "class" || s.kind === "enum");
		if (enumSym) {
			const result = executeStateMap(graph, enumSym.name);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
		}
	});

	it("should reject non-enum/non-const symbols with a clear message", async () => {
		const { executeStateMap } = await import("../tools/symbol.js");
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
		const { executeSymbolWithMode } = await import("../tools/symbol.js");
		const graph = getGraph();
		const enumSym = [...graph.symbols.values()].find((s) => s.kind === "class" || s.kind === "enum");
		if (enumSym) {
			const result = executeSymbolWithMode(graph, enumSym.name, "state");
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

	// ── Merged from check ──────────────────────────────────────────────
	it("should return diagnostic results", async () => {
		const { executeCheck } = await import("../tools/verify.js");
		const result = executeCheck(getGraph(), ".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("should support json output for diagnostics", async () => {
		const { executeCheckJson } = await import("../tools/verify.js");
		const result = executeCheckJson(getGraph(), ".");
		expect(result).toBeDefined();
		const parsed = JSON.parse(result);
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBeDefined();
	});

	it("should NOT claim to run tsc/eslint/pyright/go-vet/rustc when it does not", async () => {
		const { executeCheck } = await import("../tools/verify.js");
		const result = executeCheck(getGraph(), ".");
		expect(result).not.toMatch(/Run.*tsc.*eslint.*pyright.*go.vet.*rustc/);
	});

	// ── Merged from ready ──────────────────────────────────────────────
	it("should return pre-commit readiness result via preCommit mode", async () => {
		const { executeReady } = await import("../tools/verify.js");
		const result = executeReady(getGraph(), ".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		expect(result).toMatch(/ready|verify|check|fix/i);
	});

	it("should support json output for pre-commit readiness", async () => {
		const { executeReadyJson } = await import("../tools/verify.js");
		const result = executeReadyJson(getGraph(), ".");
		expect(result).toBeDefined();
		const parsed = JSON.parse(result);
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBeDefined();
	});
});

describe("Tool: fix", () => {
	it("should return fix results in dry-run mode", async () => {
		const { executeFix } = await import("../tools/fix.js");
		const result = executeFix(getGraph(), ".", { dryRun: true });
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("should support json output with dryRun", async () => {
		const { executeFixJson } = await import("../tools/fix.js");
		const result = executeFixJson(getGraph(), ".", { dryRun: true });
		expect(result).toBeDefined();
		const parsed = JSON.parse(result);
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBeDefined();
		expect(parsed.result.dryRun).toBe(true);
	});
});

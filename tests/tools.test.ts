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

describe("Tool: codequery", () => {
	it("should find symbol by name", async () => {
		const { executeCodequery } = await import("../tools/codequery.js");
		const result = executeCodequery(getGraph(), {
			symbol: "scanProject",
		});
		expect(result).toBeDefined();
		expect(result.symbols.length).toBeGreaterThanOrEqual(1);
		expect(result.symbols[0]!.name).toBe("scanProject");
	});

	it("should list symbols in a file", async () => {
		const { executeCodequery } = await import("../tools/codequery.js");
		const result = executeCodequery(getGraph(), {
			file: "core/scanner.ts",
		});
		expect(result).toBeDefined();
		expect(result.fileSymbols.length).toBeGreaterThan(0);
	});
});

describe("Tool: codesearch", () => {
	it("should search symbols by keyword", async () => {
		const { executeCodesearch } = await import("../tools/codesearch.js");
		const result = executeCodesearch(getGraph(), "scan");
		expect(result).toBeDefined();
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
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

describe("Tool: refs", () => {
	it("should find references to a symbol", async () => {
		const { executeRefs } = await import("../tools/refs.js");
		const graph = getGraph();
		const syms = [...graph.symbols.values()];
		const symWithIncoming = syms.find((s) => {
			const incoming = graph.incoming.get(s.id);
			return incoming && incoming.length > 0;
		});
		if (symWithIncoming) {
			const result = executeRefs(graph, symWithIncoming.name);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
		}
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
});

describe("Tool: orphan", () => {
	it("should detect potentially dead symbols", async () => {
		const { executeOrphan } = await import("../tools/orphan.js");
		const result = executeOrphan(getGraph());
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});
});

describe("Tool: routes", () => {
	it("should return route inventory (may be empty for non-web projects)", async () => {
		const { executeRoutes } = await import("../tools/routes.js");
		const result = executeRoutes(getGraph(), ".");
		expect(result).toBeDefined();
		expect(typeof result).toBe("string");
	});
});

describe("Tool: state_map", () => {
	it("should explore enum/state symbols", async () => {
		const { executeStateMap } = await import("../tools/state_map.js");
		const graph = getGraph();
		const enumSym = [...graph.symbols.values()].find(
			(s) => s.kind === "class" || s.kind === "enum",
		);
		if (enumSym) {
			const result = executeStateMap(graph, enumSym.name);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
		}
	});
});

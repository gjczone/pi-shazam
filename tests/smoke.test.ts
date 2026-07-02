/**
 * Smoke tests — end-to-end pipeline validation using the project's own codebase.
 *
 * Verifies that core pipeline (scan -> graph -> tools) produces valid,
 * non-empty output with expected structural markers.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";

let graph: RepoGraph;

beforeAll(() => {
	graph = scanProject(".");
});

// ── 1. Core pipeline ───────────────────────────────────────────────────────

describe("smoke: core pipeline", () => {
	it("scanProject builds a non-empty graph from the project itself", () => {
		expect(graph).toBeDefined();
		expect(graph.symbols.size).toBeGreaterThan(0);
		expect(graph.fileSymbols.size).toBeGreaterThan(0);
	});

	it("graph contains expected project files", () => {
		const files = Array.from(graph.fileSymbols.keys());
		expect(files).toContain("index.ts");
		const hasCoreFile = files.some((f) => f.startsWith("core/"));
		expect(hasCoreFile).toBe(true);
	});

	it("graph contains expected symbols", () => {
		const symbols = Array.from(graph.symbols.values());
		const names = symbols.map((s) => s.name);
		expect(names).toContain("scanProject");
	});

	it("graph has non-zero edge count", () => {
		const edgeCount = graph.outgoing.size;
		expect(edgeCount).toBeGreaterThan(0);
	});
});

// ── 2. Overview ────────────────────────────────────────────────────────────

describe("smoke: overview", () => {
	it("produces valid project overview with key sections", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const text = executeOverview(graph, ".");
		expect(text).toBeTruthy();
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(200);
		// Key sections expected in overview output
		expect(text).toMatch(/Project Overview/i);
		expect(text).toMatch(/Top.*Files/i);
	});

	it("overview JSON mode returns parsable JSON", async () => {
		const { executeOverviewJson } = await import("../tools/overview.js");
		const jsonText = executeOverviewJson(graph, ".");
		const parsed = JSON.parse(jsonText);
		expect(parsed).toBeDefined();
		expect(typeof parsed).toBe("object");
	});
});

// ── 3. Lookup ──────────────────────────────────────────────────────────────

describe("smoke: lookup", () => {
	it("finds a known symbol (scanProject)", async () => {
		const { executeLookupAsync } = await import("../tools/lookup.js");
		const result = await executeLookupAsync(graph, "scanProject", ".", "both", false);
		expect(result).toBeTruthy();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(50);
		expect(result).toMatch(/scanProject/i);
	});

	it("looks up a known file (index.ts)", async () => {
		const { executeLookupAsync } = await import("../tools/lookup.js");
		const result = await executeLookupAsync(graph, "index.ts", ".", "both", false);
		expect(result).toBeTruthy();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(50);
	});
});

// ── 4. Impact ──────────────────────────────────────────────────────────────

describe("smoke: impact", () => {
	it("analyzes impact on a core file", async () => {
		const { executeImpact } = await import("../tools/impact.js");
		const text = executeImpact(graph, ["core/scanner.ts"]);
		expect(text).toBeTruthy();
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(50);
		expect(text).toMatch(/impact|blast|affect/i);
	});

	it("traces symbol call chain", async () => {
		const { executeCallChain } = await import("../tools/impact.js");
		const text = executeCallChain(graph, "scanProject", 1);
		expect(text).toBeTruthy();
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(20);
	});
});

// ── 5. Format (dry run) ────────────────────────────────────────────────────

describe("smoke: format", () => {
	it("returns format scan results in dry-run mode", async () => {
		const { executeFormat } = await import("../tools/format.js");
		const result = await executeFormat(graph, ".", { dryRun: true });
		expect(result).toBeTruthy();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});
});

// ── 6. Changes ─────────────────────────────────────────────────────────────

describe("smoke: changes", () => {
	it("returns git change summary", async () => {
		const { executeChanges } = await import("../tools/changes.js");
		const text = executeChanges(graph, ".");
		expect(text).toBeTruthy();
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
		expect(text).toMatch(/change|commit|modify|risk/i);
	});
});

// ── 7. Verify ──────────────────────────────────────────────────────────────

describe("smoke: verify", () => {
	it("returns diagnostic results", async () => {
		const { executeVerify } = await import("../tools/verify.js");
		const text = executeVerify(graph, ".", { quick: true });
		expect(text).toBeTruthy();
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
	});
});

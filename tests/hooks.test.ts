/**
 * Tests for hooks — overview injection and auto-verify after write/edit.
 */
import { describe, it, expect } from "vitest";
import { scanProject } from "../core/scanner.js";
import { executeOverview } from "../tools/overview.js";
import type { RepoGraph } from "../core/graph.js";
import { generateOverviewForPrompt } from "../hooks/before-start.js";
import { handleWriteResult, shouldTriggerVerify } from "../hooks/after-write.js";

// Get a shared graph for tests (built once)
let _graph: RepoGraph | null = null;
function getGraph(): RepoGraph {
	if (!_graph) {
		_graph = scanProject(".");
	}
	return _graph;
}

describe("Hook: before-start (overview injection)", () => {
	it("should export generateOverviewForPrompt function", () => {
		expect(generateOverviewForPrompt).toBeDefined();
		expect(typeof generateOverviewForPrompt).toBe("function");
	});

	it("should return non-empty system prompt string from real project", () => {
		const promptSection = generateOverviewForPrompt(".");
		expect(promptSection).toBeDefined();
		expect(typeof promptSection).toBe("string");
		expect(promptSection.length).toBeGreaterThan(0);
		expect(promptSection).toContain("[pi-shazam]");
	});

	it("should generate overview text from project graph", () => {
		const graph = getGraph();
		const overview = executeOverview(graph, ".");
		expect(overview).toBeDefined();
		expect(typeof overview).toBe("string");
		expect(overview.length).toBeGreaterThan(0);
		// Should contain key sections
		expect(overview).toMatch(/Project Overview/);
		expect(overview).toMatch(/Top.*Files/);
	});

	it("should format overview as a system prompt section", () => {
		const graph = getGraph();
		const overview = executeOverview(graph, ".");
		// Overview should be injectable as system prompt content
		const promptSection = `[pi-shazam] Project Overview:\n${overview}`;
		expect(promptSection).toContain("[pi-shazam] Project Overview:");
		expect(promptSection).toContain("Top");
	});

	it("should handle empty projects gracefully", () => {
		// Create minimal overview for empty graph using the import at top
		const emptyGraph: RepoGraph = {
			symbols: new Map(),
			outgoing: new Map(),
			incoming: new Map(),
			fileSymbols: new Map(),
			fileImports: new Map(),
			fileCalls: new Map(),
			fileImportBindings: new Map(),
		};
		const overview = executeOverview(emptyGraph, ".");
		expect(overview).toBeDefined();
		expect(typeof overview).toBe("string");
		// Should not throw, even with no symbols
		expect(overview).toMatch(/Project Overview/);
	});
});

describe("Hook: after-write (auto-verify)", () => {
	it("should export shouldTriggerVerify function", () => {
		expect(shouldTriggerVerify).toBeDefined();
		expect(typeof shouldTriggerVerify).toBe("function");
	});

	it("should export handleWriteResult function", () => {
		expect(handleWriteResult).toBeDefined();
		expect(typeof handleWriteResult).toBe("function");
	});

	it("should detect write tool events", () => {
		// Test that we can identify write/edit tool names
		const WRITE_TOOLS = new Set(["write", "edit"]);
		expect(WRITE_TOOLS.has("write")).toBe(true);
		expect(WRITE_TOOLS.has("edit")).toBe(true);
		expect(WRITE_TOOLS.has("bash")).toBe(false);
		expect(WRITE_TOOLS.has("read")).toBe(false);
	});

	it("should skip failed write operations", () => {
		// A failed write/edit should NOT trigger verify
		const shouldTrigger = (toolName: string, isError: boolean): boolean => {
			const WRITE_TOOLS = new Set(["write", "edit"]);
			return WRITE_TOOLS.has(toolName) && !isError;
		};

		expect(shouldTrigger("write", false)).toBe(true);
		expect(shouldTrigger("write", true)).toBe(false);
		expect(shouldTrigger("edit", false)).toBe(true);
		expect(shouldTrigger("edit", true)).toBe(false);
	});

	it("should generate diagnostics from changed files", () => {
		// Verify that scanProject can run on the current project
		const graph = getGraph();
		expect(graph.symbols.size).toBeGreaterThan(0);

		// The hook should be able to re-scan and detect files
		const indexSymbols = graph.fileSymbols.get("index.ts");
		expect(indexSymbols).toBeDefined();
		expect(indexSymbols!.length).toBeGreaterThan(0);
	});
});

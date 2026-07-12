/**
 * Tests for the re-entrancy guard in getGraph (issue #691).
 *
 * getGraph() is synchronous and scanProject() is synchronous, so two MCP
 * calls cannot truly interleave. The realistic risk is a re-entrant
 * getGraph() (e.g. a hook firing during a scan) triggering a duplicate
 * scanProject. The `graphBuilding` guard must return the in-progress graph
 * instead of spawning a second scan.
 *
 * The mock scanProject invokes the captured getGraph() to simulate
 * re-entrancy synchronously without relying on live ESM exports.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Populated by the test after importing entry; used by the mock to perform a
// re-entrant getGraph() during the first scanProject call.
let capturedGetGraph: (() => unknown) | null = null;
let scanProjectCalls = 0;
let reentrantGraph: unknown = null;

vi.mock("../core/scanner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/scanner.js")>();
	return {
		...actual,
		scanProject: vi.fn().mockImplementation((root: string) => {
			scanProjectCalls++;
			// Simulate a re-entrant getGraph() while a scan is "in progress".
			// With the guard this must NOT call scanProject a second time.
			if (capturedGetGraph) {
				reentrantGraph = capturedGetGraph();
			}
			return actual.scanProject(root);
		}),
	};
});

describe("MCP: getGraph re-entrancy guard (#691)", () => {
	beforeEach(() => {
		scanProjectCalls = 0;
		reentrantGraph = null;
		capturedGetGraph = null;
		vi.resetModules();
	});

	it("does not trigger a duplicate scanProject during a re-entrant getGraph", async () => {
		const mod = await import("../mcp/entry.js");
		const { getGraph } = mod;
		capturedGetGraph = getGraph;

		// #736: re-entrant getGraph() when no cached graph is available
		// throws a descriptive error instead of silently returning null
		// (the old cachedGraph! non-null assertion was lying to TypeScript).
		expect(() => getGraph()).toThrow("Graph build already in progress but no cached graph available");
		// Only ONE scanProject call despite the re-entrant getGraph().
		expect(scanProjectCalls).toBe(1);
	});
});

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

		const result = getGraph();
		expect(result).toBeDefined();
		// During the in-progress build cachedGraph is still null, so the
		// re-entrant getGraph() returns null (defensive path) instead of
		// spawning a second scanProject.
		expect(reentrantGraph).toBeNull();
		// Only ONE scanProject call despite the re-entrant getGraph().
		expect(scanProjectCalls).toBe(1);
	});
});

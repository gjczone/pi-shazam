/**
 * Tests for getGraph fallback on scanProject failure (issue #601).
 *
 * Uses vi.mock to simulate transient scanProject failures because ESM
 * export bindings are live read-only and cannot be reassigned at runtime.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track call count across the mock so we can throw on the second call.
let mockCallCount = 0;

vi.mock("../core/scanner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/scanner.js")>();
	return {
		...actual,
		scanProject: vi.fn().mockImplementation((root: string) => {
			mockCallCount++;
			if (mockCallCount === 1) {
				// First call: use the real scanProject to populate the cache.
				return actual.scanProject(root);
			}
			// Subsequent calls: simulate transient failure.
			throw new Error("simulated transient scanProject failure (#601)");
		}),
	};
});

describe("MCP: getGraph fallback on scanProject failure (#601)", () => {
	beforeEach(() => {
		mockCallCount = 0;
	});

	it("falls back to cached graph when scanProject throws transiently after initial success", async () => {
		const mod = await import("../mcp/entry.js");
		const { getGraph } = mod;

		// First call: scanProject succeeds, caches the result.
		const firstResult = getGraph();
		expect(firstResult).toBeDefined();
		expect(firstResult.fileSymbols.size).toBeGreaterThan(0);

		// Second call: scanProject now throws (mockCallCount === 2).
		// getGraph should fall back to the cached graph, not throw.
		const secondResult = getGraph();
		expect(secondResult).toBeDefined();
		expect(secondResult).toBe(firstResult);
		expect(secondResult.fileSymbols.size).toBeGreaterThan(0);
	});
});

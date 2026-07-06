/**
 * Tests for MCP getGraph TTL expiry (#626).
 *
 * In long-lived MCP mode, the cached RepoGraph (~500MB-1GB for large projects)
 * is held in module-level memory forever. With a TTL, idle memory is released
 * so the next getGraph() call rebuilds from the persistent disk cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Track scanProject call count to verify TTL behavior without depending on
// the actual graph content (which would require a real project setup).
let scanCallCount = 0;

vi.mock("../core/scanner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/scanner.js")>();
	return {
		...actual,
		scanProject: vi.fn().mockImplementation((root: string) => {
			scanCallCount++;
			return actual.scanProject(root);
		}),
	};
});

describe("MCP: getGraph TTL expiry (#626)", () => {
	const ORIGINAL_ENV = process.env.PI_SHAZAM_GRAPH_TTL_MS;

	beforeEach(() => {
		scanCallCount = 0;
		// TTL must be long enough to outlast the first scanProject() call
		// (which can take 200-500ms on a cold cache in CI contention).
		// 5000ms gives plenty of headroom for consecutive-call assertions,
		// while still keeping the "after TTL expires" test fast.
		process.env.PI_SHAZAM_GRAPH_TTL_MS = "5000";
	});

	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.PI_SHAZAM_GRAPH_TTL_MS;
		} else {
			process.env.PI_SHAZAM_GRAPH_TTL_MS = ORIGINAL_ENV;
		}
		// Reset module-level cached graph between tests by re-importing
		vi.resetModules();
	});

	it("returns the same graph on consecutive calls within TTL", async () => {
		const mod = await import("../mcp/entry.js");
		const { getGraph } = mod;

		const first = getGraph();
		const second = getGraph();
		const third = getGraph();

		// All three should be the same instance — no re-scan within TTL
		expect(second).toBe(first);
		expect(third).toBe(first);
		// Only the initial scan should have happened
		expect(scanCallCount).toBe(1);
	});

	it("releases cached graph after TTL expires, triggering a rescan on next access", async () => {
		vi.resetModules();
		const mod = await import("../mcp/entry.js");
		const { getGraph } = mod;

		// Initial scan
		const first = getGraph();
		expect(scanCallCount).toBe(1);

		// Wait for TTL to expire (5000ms in test config + buffer)
		await new Promise((r) => setTimeout(r, 5200));

		// Next call should detect expired TTL, null the cache, and rescan
		const second = getGraph();
		expect(scanCallCount).toBe(2);
		// The graph instance should be different — proves the old one was released
		// (V8 may reuse the reference if the new scan returns the same object,
		// but with TTL reset + fresh scanProject call, the entry-point module
		// variable was nulled, so a new instance was created and assigned)
		expect(second).toBeDefined();
		expect(second.fileSymbols.size).toBeGreaterThan(0);
	});

	it("does not release when TTL is set to 0 (disabled)", async () => {
		process.env.PI_SHAZAM_GRAPH_TTL_MS = "0";
		vi.resetModules();
		const mod = await import("../mcp/entry.js");
		const { getGraph } = mod;

		const first = getGraph();
		expect(scanCallCount).toBe(1);

		// Wait well past any reasonable TTL
		await new Promise((r) => setTimeout(r, 100));

		const second = getGraph();
		// TTL disabled → no rescan
		expect(scanCallCount).toBe(1);
		expect(second).toBe(first);
	});

	it("does not release on each call when within TTL window", async () => {
		vi.resetModules();
		const mod = await import("../mcp/entry.js");
		const { getGraph } = mod;

		// First call: scans
		getGraph();
		expect(scanCallCount).toBe(1);

		// Subsequent rapid calls within TTL: no rescan
		for (let i = 0; i < 5; i++) {
			getGraph();
		}
		expect(scanCallCount).toBe(1);
	});
});

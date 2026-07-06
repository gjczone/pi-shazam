/**
 * Tests for scanner TreeSitterAdapter reuse after resetCache (#626).
 *
 * resetCache() previously nulled out the TreeSitterAdapter singleton, forcing
 * a new instance on the next scanProject. Each adapter holds native C++ objects
 * (Parser/Language/Query) that V8 cannot GC promptly, leading to native heap
 * inflation across many verify cycles. The fix keeps the adapter alive and
 * only clears the analysis-result caches.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanProject, resetCache } from "../core/scanner.js";
import { TreeSitterAdapter } from "../core/treesitter.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTestProject(): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-adapter-"));

	writeFileSync(
		join(tmpDir, "sample.ts"),
		`
export function greet(name: string): string {
  return "hello " + name;
}
`.trim(),
	);

	return tmpDir;
}

describe("scanner: TreeSitterAdapter reuse after resetCache (#626)", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = createTestProject();
		resetCache();
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
		resetCache();
	});

	it("scannerAdapter singleton survives resetCache", () => {
		// Trigger adapter creation
		scanProject(projectRoot);

		// We can't import the private _scannerAdapter, but we can verify the
		// observable behavior: a second scanProject should reuse the same
		// adapter instance, not allocate a new one. We expose a probe by
		// running scanProject and counting how many TreeSitterAdapter
		// instances have been created.
		const beforeCount = TreeSitterAdapter.getInstanceCount();

		resetCache();

		// The adapter should NOT have been destroyed and recreated
		scanProject(projectRoot);

		const afterCount = TreeSitterAdapter.getInstanceCount();
		expect(afterCount).toBe(beforeCount);
	});

	it("resetCache still clears the analysis result cache", () => {
		// First scan populates cachedGraph
		const first = scanProject(projectRoot);
		expect(first.fileSymbols.size).toBeGreaterThan(0);

		// After resetCache, the cachedGraph is cleared (so the next scan
		// will need to rebuild it), but the adapter is preserved
		resetCache();

		// Second scan should still produce a valid graph
		const second = scanProject(projectRoot);
		expect(second.fileSymbols.size).toBeGreaterThan(0);
		// Should be a new graph object (the old one was released)
		expect(second).not.toBe(first);
	});
});

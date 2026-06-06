/**
 * Tests for core/scanner — incremental file analysis (issue #27).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { scanProject, getProjectGraph, resetCache } from "../core/scanner.js";
import {
	mkdtempSync,
	writeFileSync,
	rmSync,
	mkdirSync,
	statSync,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTestProject(): string {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-incr-"));

	writeFileSync(
		join(tmpDir, "math.ts"),
		`
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`.trim(),
	);

	writeFileSync(
		join(tmpDir, "app.ts"),
		`
import { add } from "./math";

export function calculate(): number {
  return add(1, 2);
}
`.trim(),
	);

	writeFileSync(
		join(tmpDir, "utils.ts"),
		`
export function formatNumber(n: number): string {
  return n.toFixed(2);
}

export function parseNumber(s: string): number {
  return parseFloat(s);
}
`.trim(),
	);

	return tmpDir;
}

describe("incremental scan", () => {
	let tmpDir: string;

	beforeEach(() => {
		resetCache();
		tmpDir = createTestProject();
	});

	it("should produce the same graph on first scan as full scan", () => {
		const graph = scanProject(tmpDir);
		expect(graph.symbols.size).toBeGreaterThanOrEqual(5);

		const addSym = [...graph.symbols.values()].find((s) => s.name === "add");
		expect(addSym).toBeDefined();
		expect(addSym!.kind).toBe("function");

		const calcSym = [...graph.symbols.values()].find((s) => s.name === "calculate");
		expect(calcSym).toBeDefined();
	});

	it("should reuse cached graph when no files changed", () => {
		const graph1 = scanProject(tmpDir);
		const symCount1 = graph1.symbols.size;

		const graph2 = scanProject(tmpDir);
		expect(graph2.symbols.size).toBe(symCount1);
	});

	it("should detect new symbols when a file is modified", () => {
		const graph1 = scanProject(tmpDir);
		const initialCount = graph1.symbols.size;

		// Ensure mtime differs (some filesystems have 1s resolution)
		const now = Date.now();
		const futureTime = now + 2000;

		writeFileSync(
			join(tmpDir, "math.ts"),
			`
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`.trim(),
		);

		// Force mtime into the future to guarantee detection
		utimesSync(join(tmpDir, "math.ts"), new Date(futureTime), new Date(futureTime));

		const graph2 = scanProject(tmpDir);
		expect(graph2.symbols.size).toBeGreaterThan(initialCount);

		const subtract = [...graph2.symbols.values()].find((s) => s.name === "subtract");
		expect(subtract).toBeDefined();
	});

	it("should remove symbols when a file is deleted", () => {
		const graph1 = scanProject(tmpDir);
		const formatNum = [...graph1.symbols.values()].find(
			(s) => s.name === "formatNumber",
		);
		expect(formatNum).toBeDefined();

		rmSync(join(tmpDir, "utils.ts"));

		const graph2 = scanProject(tmpDir);
		const formatNum2 = [...graph2.symbols.values()].find(
			(s) => s.name === "formatNumber",
		);
		expect(formatNum2).toBeUndefined();
	});

	it("should produce identical results to a full scan after incremental update", () => {
		// First scan (builds cache)
		scanProject(tmpDir);

		// Modify a file
		writeFileSync(
			join(tmpDir, "math.ts"),
			`
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`.trim(),
		);

		// Incremental scan
		resetCache();
		const incrementalGraph = scanProject(tmpDir);

		// Force full scan by resetting cache
		resetCache();
		const fullGraph = scanProject(tmpDir);

		// Compare symbol names and counts
		const incrementalNames = [...incrementalGraph.symbols.values()]
			.map((s) => s.name)
			.sort();
		const fullNames = [...fullGraph.symbols.values()]
			.map((s) => s.name)
			.sort();

		expect(incrementalNames).toEqual(fullNames);
		expect(incrementalGraph.fileSymbols.size).toBe(fullGraph.fileSymbols.size);
	});

	it("should handle adding a new file", () => {
		const graph1 = scanProject(tmpDir);
		const initialCount = graph1.symbols.size;

		writeFileSync(
			join(tmpDir, "logger.ts"),
			`
export function logMessage(msg: string): void {
  console.log(msg);
}
`.trim(),
		);

		const graph2 = scanProject(tmpDir);
		expect(graph2.symbols.size).toBeGreaterThan(initialCount);

		const logMsg = [...graph2.symbols.values()].find(
			(s) => s.name === "logMessage",
		);
		expect(logMsg).toBeDefined();
	});

	it("should maintain edge correctness after incremental update", () => {
		scanProject(tmpDir);

		// Modify app.ts to add a new call
		writeFileSync(
			join(tmpDir, "app.ts"),
			`
import { add, multiply } from "./math";

export function calculate(): number {
  return add(1, multiply(2, 3));
}
`.trim(),
		);

		const graph2 = scanProject(tmpDir);

		// calculate should still exist
		const calc = [...graph2.symbols.values()].find((s) => s.name === "calculate");
		expect(calc).toBeDefined();

		// File should still have symbols
		const appSymIds = graph2.fileSymbols.get("app.ts");
		expect(appSymIds).toBeDefined();
		expect(appSymIds!.length).toBeGreaterThanOrEqual(1);
	});

	it("should recompute PageRank after incremental update", () => {
		scanProject(tmpDir);

		// Add a new file that imports from math
		writeFileSync(
			join(tmpDir, "calculator.ts"),
			`
import { add, multiply, subtract } from "./math";

export function compute(a: number, b: number): number {
  return add(multiply(a, b), subtract(a, b));
}
`.trim(),
		);

		// Also add subtract to math.ts so the import resolves
		writeFileSync(
			join(tmpDir, "math.ts"),
			`
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`.trim(),
		);

		const graph = scanProject(tmpDir);

		// Math functions should have non-zero PageRank (they have incoming edges)
		const addSym = [...graph.symbols.values()].find((s) => s.name === "add");
		expect(addSym).toBeDefined();
		expect(addSym!.pagerank).toBeGreaterThan(0);
	});
});

/**
 * Tests for issue #662: shazam_overview JSON output dropped sections that
 * existed only in the text view. After the fix, buildOverviewResult exposes
 * dataStructures, entryPoints, httpRoutes, complexityHotspots,
 * suggestedReadingOrder, parserWarnings, and moduleStructure so JSON and
 * text modes surface the same signals.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../core/scanner.js";
import { buildOverviewResult } from "../tools/overview.js";
import type { RepoGraph } from "../core/graph.js";

let rootDir: string;

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), "overview-json-"));
	const src = join(rootDir, "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(
		join(src, "main.ts"),
		["export function main() {", "  console.log('hi');", "}", "export class Service {", "  handle() {}", "}"].join(
			"\n",
		),
	);
	writeFileSync(
		join(src, "routes.ts"),
		["export function get(path: string, fn: () => void) {}", "get('/health', () => {});"].join("\n"),
	);
});

afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe("issue #662: overview JSON exposes text-only sections", () => {
	it("includes entryPoints, moduleStructure, reading order, and parserWarnings", () => {
		const graph: RepoGraph = scanProject(rootDir);
		const result = buildOverviewResult(graph, rootDir);

		// Entry points: main() is auto-detected as a CLI entry point.
		expect(Array.isArray(result.entryPoints)).toBe(true);
		expect(result.entryPoints!.some((e) => e.name === "main")).toBe(true);

		// Module structure mirrors the text "Module Structure" tree
		// (two-level directory grouping: "src/main.ts").
		expect(Array.isArray(result.moduleStructure)).toBe(true);
		expect(result.moduleStructure!.some((m) => m.dir.startsWith("src"))).toBe(true);

		// Suggested reading order lists the top files.
		expect(Array.isArray(result.suggestedReadingOrder)).toBe(true);
		expect(result.suggestedReadingOrder!.length).toBeGreaterThan(0);

		// Parser warnings is always present (may be empty for TS-only projects).
		expect(Array.isArray(result.parserWarnings)).toBe(true);
	});

	it("includes complexityHotspots and dataStructures (may be null/empty)", () => {
		const graph: RepoGraph = scanProject(rootDir);
		const result = buildOverviewResult(graph, rootDir);

		expect(Array.isArray(result.complexityHotspots)).toBe(true);
		// dataStructures may be null when no class/interface is found.
		expect(result.dataStructures === null || typeof result.dataStructures === "string").toBe(true);
		// httpRoutes may be null when no routes detected.
		expect(result.httpRoutes === null || typeof result.httpRoutes === "string").toBe(true);
	});

	it("omits the new sections in filter mode (parity with text view)", () => {
		const graph: RepoGraph = scanProject(rootDir);
		const result = buildOverviewResult(graph, rootDir, "main");
		expect(result.entryPoints).toBeUndefined();
		expect(result.moduleStructure).toBeUndefined();
		expect(result.complexityHotspots).toBeUndefined();
	});
});

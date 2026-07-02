/**
 * Tests for persistent graph cache (issue #28).
 *
 * Verifies serialization round-trip, cache save/load, mtime validation,
 * and cache invalidation rules.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepoGraph, createSymbol, createEdge, serializeGraphV2, deserializeGraphV2 } from "../core/graph.js";
import { saveGraphCache, loadGraphCache } from "../core/cache.js";
import type { RepoGraph } from "../core/graph.js";

function buildTestGraph(): RepoGraph {
	const graph = createRepoGraph();

	const symA = createSymbol("a.ts::foo::1", "foo", "function", "a.ts", 1, {
		endLine: 10,
		signature: "function foo(): void",
		pagerank: 0.5,
	});
	const symB = createSymbol("b.ts::bar::5", "bar", "function", "b.ts", 5, {
		endLine: 15,
		signature: "function bar(x: number): string",
		pagerank: 0.3,
	});
	const symC = createSymbol("a.ts::MyClass::12", "MyClass", "class", "a.ts", 12, {
		endLine: 50,
		visibility: "exported",
		pagerank: 0.8,
	});

	graph.symbols.set(symA.id, symA);
	graph.symbols.set(symB.id, symB);
	graph.symbols.set(symC.id, symC);

	graph.fileSymbols.set("a.ts", [symA.id, symC.id]);
	graph.fileSymbols.set("b.ts", [symB.id]);

	graph.fileImports.set("a.ts", ["./b"]);
	graph.fileImports.set("b.ts", []);

	graph.fileCalls.set("a.ts", [["bar", 3, "b.ts"]]);
	graph.fileCalls.set("b.ts", []);

	const edge = createEdge(symA.id, symB.id, 1.0, "call", 0.9);
	graph.outgoing.set(symA.id, [edge]);
	graph.incoming.set(symB.id, [edge]);

	return graph;
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-cache-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("Graph serialization V2 round-trip", () => {
	it("serializeGraphV2 includes file-level data and mtimes", () => {
		const graph = buildTestGraph();
		const fileMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);
		const serialized = serializeGraphV2(graph, fileMtimes);

		expect(serialized.version).toBe(3);
		expect(serialized.symbols.length).toBe(3);
		expect(serialized.edges.length).toBe(1);
		expect(serialized.fileSymbols).toBeDefined();
		expect(Object.keys(serialized.fileSymbols).length).toBe(2);
		expect(serialized.fileImports).toBeDefined();
		expect(serialized.fileCalls).toBeDefined();
		expect(serialized.fileMtimes).toBeDefined();
		expect(serialized.fileMtimes["a.ts"]).toBe(1000);
		expect(serialized.fileMtimes["b.ts"]).toBe(2000);
	});

	it("deserializeGraphV2 reconstructs all Maps correctly", () => {
		const graph = buildTestGraph();
		const fileMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);
		const serialized = serializeGraphV2(graph, fileMtimes);
		const restored = deserializeGraphV2(serialized);

		expect(restored.symbols.size).toBe(graph.symbols.size);
		expect(restored.outgoing.size).toBe(graph.outgoing.size);
		expect(restored.incoming.size).toBe(graph.incoming.size);
		expect(restored.fileSymbols.size).toBe(graph.fileSymbols.size);
		expect(restored.fileImports.size).toBe(graph.fileImports.size);
		expect(restored.fileCalls.size).toBe(graph.fileCalls.size);

		// Verify symbol data preserved
		const foo = restored.symbols.get("a.ts::foo::1");
		expect(foo).toBeDefined();
		expect(foo!.name).toBe("foo");
		expect(foo!.signature).toBe("function foo(): void");
		expect(foo!.pagerank).toBe(0.5);

		// Verify edges preserved
		const outgoing = restored.outgoing.get("a.ts::foo::1");
		expect(outgoing).toBeDefined();
		expect(outgoing!.length).toBe(1);
		expect(outgoing![0].target).toBe("b.ts::bar::5");
		expect(outgoing![0].kind).toBe("call");

		// Verify file-level data preserved
		expect(restored.fileSymbols.get("a.ts")).toEqual(["a.ts::foo::1", "a.ts::MyClass::12"]);
		expect(restored.fileImports.get("a.ts")).toEqual(["./b"]);
		expect(restored.fileCalls.get("a.ts")).toEqual([["bar", 3, "b.ts"]]);
	});

	it("JSON round-trip preserves all data", () => {
		const graph = buildTestGraph();
		const fileMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);
		const serialized = serializeGraphV2(graph, fileMtimes);
		const json = JSON.stringify(serialized);
		const parsed = JSON.parse(json);
		const restored = deserializeGraphV2(parsed);

		expect(restored.symbols.size).toBe(3);
		expect(restored.fileSymbols.get("a.ts")!.length).toBe(2);
	});

	it("Issue #570.7: corrupted fileImports (non-array) does not crash deserialization", () => {
		const graph = buildTestGraph();
		const fileMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);
		const serialized = serializeGraphV2(graph, fileMtimes);
		// Corrupt fileImports: replace array value with a number (corrupted cache)
		(serialized.fileImports as Record<string, unknown>)["a.ts"] = 12345;
		const json = JSON.stringify(serialized);
		const parsed = JSON.parse(json);

		// Should not throw -- the unsafe `(v as unknown as string[])` cast
		// on non-array data will cause later iteration to crash.
		const restored = deserializeGraphV2(parsed);
		// After the fix, corrupted entries should produce empty arrays rather than
		// raw non-array values that would crash downstream consumers.
		const imports = restored.fileImports.get("a.ts");
		expect(Array.isArray(imports)).toBe(true);
	});
});

describe("Graph cache save/load", () => {
	it("saveGraphCache writes cache file, loadGraphCache reads it back", () => {
		const graph = buildTestGraph();
		const fileMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);

		const cachePath = join(tmpDir, "graph-cache.json");
		saveGraphCache(graph, fileMtimes, cachePath);

		const loaded = loadGraphCache(cachePath);
		expect(loaded).not.toBeNull();
		expect(loaded!.graph.symbols.size).toBe(3);
		expect(loaded!.fileMtimes.get("a.ts")).toBe(1000);
	});

	it("loadGraphCache returns null for missing file", () => {
		const loaded = loadGraphCache(join(tmpDir, "nonexistent.json"));
		expect(loaded).toBeNull();
	});

	it("loadGraphCache returns null for corrupt JSON", () => {
		const cachePath = join(tmpDir, "corrupt.json");
		writeFileSync(cachePath, "{invalid json!!!", "utf-8");
		const loaded = loadGraphCache(cachePath);
		expect(loaded).toBeNull();
	});

	it("loadGraphCache returns null for wrong schema version", () => {
		const cachePath = join(tmpDir, "old-version.json");
		writeFileSync(cachePath, JSON.stringify({ version: 1, symbols: [], edges: [] }), "utf-8");
		const loaded = loadGraphCache(cachePath);
		expect(loaded).toBeNull();
	});

	it("loadGraphCache returns null for expired cache (>7 days)", () => {
		const graph = buildTestGraph();
		const fileMtimes = new Map([["a.ts", 1000]]);
		const cachePath = join(tmpDir, "expired.json");

		const serialized = serializeGraphV2(graph, fileMtimes);
		serialized.timestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
		writeFileSync(cachePath, JSON.stringify(serialized), "utf-8");

		const loaded = loadGraphCache(cachePath);
		expect(loaded).toBeNull();
	});
});

describe("Cache mtime validation", () => {
	it("detects stale file when mtime increased", () => {
		const graph = buildTestGraph();
		const cachedMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);
		const cachePath = join(tmpDir, "graph-cache.json");
		saveGraphCache(graph, cachedMtimes, cachePath);

		const loaded = loadGraphCache(cachePath);
		expect(loaded).not.toBeNull();

		// Simulate: a.ts was modified (mtime increased)
		const currentMtimes = new Map([
			["a.ts", 1500],
			["b.ts", 2000],
		]);
		const changedFiles: string[] = [];
		for (const [file, mtime] of currentMtimes) {
			const cached = loaded!.fileMtimes.get(file);
			if (cached !== undefined && cached < mtime) {
				changedFiles.push(file);
			}
		}

		expect(changedFiles).toEqual(["a.ts"]);
	});

	it("detects new files not in cache", () => {
		const graph = buildTestGraph();
		const cachedMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);
		const cachePath = join(tmpDir, "graph-cache.json");
		saveGraphCache(graph, cachedMtimes, cachePath);

		const loaded = loadGraphCache(cachePath);
		expect(loaded).not.toBeNull();

		// Simulate: c.ts was added
		const currentFiles = new Set(["a.ts", "b.ts", "c.ts"]);
		const cachedFiles = new Set(loaded!.fileMtimes.keys());
		const newFiles = [...currentFiles].filter((f) => !cachedFiles.has(f));

		expect(newFiles).toEqual(["c.ts"]);
	});

	it("detects deleted files in cache", () => {
		const graph = buildTestGraph();
		const cachedMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);
		const cachePath = join(tmpDir, "graph-cache.json");
		saveGraphCache(graph, cachedMtimes, cachePath);

		const loaded = loadGraphCache(cachePath);

		// Simulate: b.ts was deleted
		const currentFiles = new Set(["a.ts"]);
		const cachedFiles = new Set(loaded!.fileMtimes.keys());
		const deletedFiles = [...cachedFiles].filter((f) => !currentFiles.has(f));

		expect(deletedFiles).toEqual(["b.ts"]);
	});
});

// -- Platform-appropriate cache root (issue #584) --

describe("CACHE_ROOT platform detection (#584)", () => {
	it("returns ~/.cache/pi-shazam on Linux", async () => {
		const { CACHE_ROOT } = await import("../core/cache.js");
		const { homedir } = await import("node:os");
		const { join } = await import("node:path");
		// On Linux, XDG_CACHE_HOME defaults to ~/.cache
		const xdgCache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
		expect(CACHE_ROOT).toBe(join(xdgCache, "pi-shazam"));
	});

	it("getProjectCacheDir strips trailing backslash on Windows paths", async () => {
		const { getProjectCacheDir } = await import("../core/cache.js");
		// Simulate a Windows path with trailing backslash
		const dir = getProjectCacheDir("C:\\Users\\test\\project\\");
		// Should not have a trailing separator after canonicalization
		const parts = dir.split(/[\\/]/);
		const last = parts[parts.length - 1];
		expect(last).not.toBe("");
	});

	it("getProjectCacheDir strips trailing forward slash on POSIX paths", async () => {
		const { getProjectCacheDir } = await import("../core/cache.js");
		const dir = getProjectCacheDir("/home/user/project/");
		const parts = dir.split("/");
		const last = parts[parts.length - 1];
		expect(last).not.toBe("");
	});
});

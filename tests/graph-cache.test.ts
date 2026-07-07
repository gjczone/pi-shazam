/**
 * Tests for persistent graph cache (issue #28).
 *
 * Verifies serialization round-trip, cache save/load, mtime validation,
 * and cache invalidation rules.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepoGraph, createSymbol, createEdge, serializeGraphV2, deserializeGraphV2 } from "../core/graph.js";
import { saveGraphCache, loadGraphCache, CACHE_V3_MAGIC, CACHE_V3_1_MAGIC, CACHE_V3_0_MAGIC } from "../core/cache.js";
import {
	encodeGraphPayloadV31,
	decodeGraphPayload,
	type ProtoGraphPayload,
	type ProtoGraphPayloadV31,
} from "../core/proto-schema.js";
import { serializeGraphV3 } from "../core/cache.js";
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

/**
 * End-to-end coverage of the V3.1 (ProtoBuf) on-disk path.
 *
 * `tests/cache-v3.test.ts` exercises `serializeGraphV3` /
 * `deserializeGraphV3` directly in memory. These tests go through
 * the full save-to-disk + load-from-disk path so the magic-byte
 * routing, atomic-rename, and file-size guards are covered.
 */
describe("V3.1 on-disk round-trip (issue #647)", () => {
	it("saveGraphCache writes a V3.1 cache, loadGraphCache reads it back exactly", () => {
		const graph = buildTestGraph();
		const fileMtimes = new Map([
			["a.ts", 1000],
			["b.ts", 2000],
		]);
		const cachePath = join(tmpDir, "v3-roundtrip.bin");
		saveGraphCache(graph, fileMtimes, cachePath);

		const loaded = loadGraphCache(cachePath);
		expect(loaded).not.toBeNull();
		// Symbol table round-trips
		expect(loaded!.graph.symbols.size).toBe(3);
		expect(loaded!.graph.symbols.get("a.ts::foo::1")?.pagerank).toBe(0.5);
		// Symbol-level edge round-trips
		const out = loaded!.graph.outgoing.get("a.ts::foo::1");
		expect(out).toBeDefined();
		expect(out!.length).toBe(1);
		expect(out![0]?.target).toBe("b.ts::bar::5");
		expect(out![0]?.kind).toBe("call");
		// Incoming index rebuilt
		const inc = loaded!.graph.incoming.get("b.ts::bar::5");
		expect(inc).toBeDefined();
		expect(inc!.length).toBe(1);
		// File-level map round-trips (in-memory shape is [symId, line, kind])
		expect(loaded!.graph.fileCalls.get("a.ts")).toEqual([["bar", 3, "call"]]);
		// mtimes + timestamp round-trip
		expect(loaded!.fileMtimes.get("a.ts")).toBe(1000);
		expect(loaded!.fileMtimes.get("b.ts")).toBe(2000);
		expect(loaded!.timestamp).toBeGreaterThan(0);
	});

	it("V3.2 cache file is prefixed with the SHA\\5 magic header", () => {
		const graph = buildTestGraph();
		const cachePath = join(tmpDir, "v3-magic.bin");
		saveGraphCache(graph, new Map(), cachePath);
		const bytes = readFileSync(cachePath);
		expect(bytes.length).toBeGreaterThanOrEqual(4);
		// 'S' 'H' 'A' '\\5' (V3.2, since issue #647 follow-up D)
		expect(bytes[0]).toBe(0x53);
		expect(bytes[1]).toBe(0x48);
		expect(bytes[2]).toBe(0x41);
		expect(bytes[3]).toBe(0x05);
		// Sanity: the constant agrees with what was written
		expect(CACHE_V3_MAGIC[0]).toBe(0x53);
		expect(CACHE_V3_MAGIC[3]).toBe(0x05);
	});

	it("loadGraphCache returns null for a corrupted V3.1 buffer without throwing", () => {
		// Real V3.1 magic followed by binary garbage. The deserializer
		// should fail (length mismatch on the index columns, per the
		// defensive check in deserializeGraphV3) and loadGraphCache
		// must swallow the error and return null.
		const bad = Buffer.concat([CACHE_V3_MAGIC, Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb])]);
		const cachePath = join(tmpDir, "v3-corrupt.bin");
		writeFileSync(cachePath, bad);
		const loaded = loadGraphCache(cachePath);
		expect(loaded).toBeNull();
	});

	it("loadGraphCache returns null for a V3.0 (0x03 magic) cache -- silent upgrade path", () => {
		// Regression guard for the V3.0 -> V3.1 transition. When a
		// user upgrades from a pi-shazam version that wrote V3.0
		// caches (magic 0x03), `loadGraphCache` must fall through to
		// the V2 JSON path and return null (the V2 path fails to
		// JSON.parse the binary blob, so the loader discards it and
		// the scanner rebuilds on the next scan). This MUST NOT
		// throw -- the whole point of the silent-drop path is to
		// keep upgrades working.
		const oldMagic = Buffer.from([0x53, 0x48, 0x41, 0x03]); // SHA\3
		const v30Body = Buffer.from("this is binary protobuf, not JSON, should fail to parse");
		const oldCache = Buffer.concat([oldMagic, v30Body]);
		const cachePath = join(tmpDir, "v30-legacy.bin");
		writeFileSync(cachePath, oldCache);
		const loaded = loadGraphCache(cachePath);
		expect(loaded).toBeNull();
	});
});

/**
 * Issue #647 (follow-up E): in-place upgrade of V3.0 / V3.1 caches
 * to V3.2 on first load. `loadGraphCache` detects the legacy magic,
 * decodes via the version-specific reader, then re-encodes as V3.2
 * and atomically replaces the file. The user pays no re-scan cost
 * on upgrade.
 */
describe("V3.0 / V3.1 in-place upgrade to V3.2 (issue #647 follow-up E)", () => {
	/** Build a V3.1 buffer (magic 0x04, kind as string) for a given graph. */
	function buildV31Buffer(graph: RepoGraph): Buffer {
		const v32 = serializeGraphV3(graph);
		const v32Payload = decodeGraphPayload(v32.subarray(CACHE_V3_MAGIC.length)) as ProtoGraphPayload;
		const v31Payload: ProtoGraphPayloadV31 = {
			metadata: v32Payload.metadata,
			edges: {
				source: v32Payload.edges!.source,
				target: v32Payload.edges!.target,
				weight: v32Payload.edges!.weight,
				kind: (v32Payload.edges!.kind as unknown as number[]).map((n) =>
					n === 0
						? "call"
						: n === 1
							? "type"
							: n === 2
								? "import"
								: n === 3
									? "ref"
									: n === 4
										? "typeRef"
										: n === 5
											? "import-binding"
											: "call",
				),
				confidence: v32Payload.edges!.confidence,
				provenance: v32Payload.edges!.provenance,
			},
			file_edges: {
				file: v32Payload.file_edges!.file,
				symbol_id: v32Payload.file_edges!.symbol_id,
				count: v32Payload.file_edges!.count,
				kind: (v32Payload.file_edges!.kind as unknown as number[]).map((n) =>
					n === 0 ? "call" : n === 3 ? "ref" : n === 4 ? "typeRef" : "call",
				),
			},
			string_table: v32Payload.string_table ?? [],
			edge_source_idx: v32Payload.edge_source_idx ?? [],
			edge_target_idx: v32Payload.edge_target_idx ?? [],
		};
		return Buffer.concat([CACHE_V3_1_MAGIC, encodeGraphPayloadV31(v31Payload)]);
	}

	/** Build a V3.0 buffer (magic 0x03, kind as string, no string table). */
	function buildV30Buffer(graph: RepoGraph): Buffer {
		const v32 = serializeGraphV3(graph);
		const v32Payload = decodeGraphPayload(v32.subarray(CACHE_V3_MAGIC.length)) as ProtoGraphPayload;
		const stringTable = v32Payload.string_table ?? [];
		const sourceIdx = v32Payload.edge_source_idx ?? [];
		const targetIdx = v32Payload.edge_target_idx ?? [];
		const inlineSource: string[] = sourceIdx.map((i) => stringTable[i] ?? "");
		const inlineTarget: string[] = targetIdx.map((i) => stringTable[i] ?? "");
		const v30Payload: ProtoGraphPayloadV31 = {
			metadata: v32Payload.metadata,
			edges: {
				source: inlineSource,
				target: inlineTarget,
				weight: v32Payload.edges!.weight,
				kind: (v32Payload.edges!.kind as unknown as number[]).map((n) =>
					n === 0
						? "call"
						: n === 1
							? "type"
							: n === 2
								? "import"
								: n === 3
									? "ref"
									: n === 4
										? "typeRef"
										: n === 5
											? "import-binding"
											: "call",
				),
				confidence: v32Payload.edges!.confidence,
				provenance: v32Payload.edges!.provenance,
			},
			file_edges: {
				file: v32Payload.file_edges!.file,
				symbol_id: v32Payload.file_edges!.symbol_id,
				count: v32Payload.file_edges!.count,
				kind: (v32Payload.file_edges!.kind as unknown as number[]).map((n) =>
					n === 0 ? "call" : n === 3 ? "ref" : n === 4 ? "typeRef" : "call",
				),
			},
			string_table: [],
			edge_source_idx: [],
			edge_target_idx: [],
		};
		return Buffer.concat([CACHE_V3_0_MAGIC, encodeGraphPayloadV31(v30Payload)]);
	}

	it("V3.1 cache (magic 0x04) loads + upgrades to V3.2 in place", () => {
		const graph = buildTestGraph();
		const cachePath = join(tmpDir, "v31-to-v32.bin");
		writeFileSync(cachePath, buildV31Buffer(graph));
		// Confirm the on-disk file is V3.1 before the call.
		expect(readFileSync(cachePath).subarray(0, 4).equals(CACHE_V3_1_MAGIC)).toBe(true);

		const loaded = loadGraphCache(cachePath);
		expect(loaded).not.toBeNull();
		expect(loaded!.graph.symbols.size).toBe(3);
		expect(loaded!.graph.outgoing.get("a.ts::foo::1")?.[0]?.kind).toBe("call");
		// The in-place upgrade replaced the file: magic is now 0x05.
		const after = readFileSync(cachePath);
		expect(after.subarray(0, 4).equals(CACHE_V3_MAGIC)).toBe(true);
		expect(after.subarray(0, 4).equals(CACHE_V3_1_MAGIC)).toBe(false);
	});

	it("V3.0 cache (magic 0x03) loads + upgrades to V3.2 in place", () => {
		const graph = buildTestGraph();
		const cachePath = join(tmpDir, "v30-to-v32.bin");
		writeFileSync(cachePath, buildV30Buffer(graph));
		// Confirm the on-disk file is V3.0 before the call.
		expect(readFileSync(cachePath).subarray(0, 4).equals(CACHE_V3_0_MAGIC)).toBe(true);

		const loaded = loadGraphCache(cachePath);
		expect(loaded).not.toBeNull();
		expect(loaded!.graph.symbols.size).toBe(3);
		// The in-place upgrade replaced the file: magic is now 0x05.
		const after = readFileSync(cachePath);
		expect(after.subarray(0, 4).equals(CACHE_V3_MAGIC)).toBe(true);
	});

	it("V3.2 cache (magic 0x05) is read directly without re-encoding", () => {
		const graph = buildTestGraph();
		const cachePath = join(tmpDir, "v32-direct.bin");
		saveGraphCache(graph, new Map(), cachePath);
		// Capture the file's bytes so we can verify the load
		// doesn't rewrite it. A re-encode would produce a
		// different timestamp in the metadata JSON, so the bytes
		// would change.
		const before = readFileSync(cachePath);
		const loaded = loadGraphCache(cachePath);
		expect(loaded).not.toBeNull();
		const after = readFileSync(cachePath);
		// V3.2 path is read-only; bytes are identical.
		expect(after.equals(before)).toBe(true);
	});

	it("V3.1 upgrade preserves fileMtimes through the round-trip", () => {
		const graph = buildTestGraph();
		const fileMtimes = new Map([
			["a.ts", 12345],
			["b.ts", 67890],
		]);
		// Build a V3.1 buffer that has these fileMtimes baked in.
		const v32WithMtimes = serializeGraphV3(graph, fileMtimes);
		const v32Payload = decodeGraphPayload(v32WithMtimes.subarray(CACHE_V3_MAGIC.length)) as ProtoGraphPayload;
		const v31Payload: ProtoGraphPayloadV31 = {
			metadata: v32Payload.metadata,
			edges: {
				source: v32Payload.edges!.source,
				target: v32Payload.edges!.target,
				weight: v32Payload.edges!.weight,
				kind: (v32Payload.edges!.kind as unknown as number[]).map(() => "call"),
				confidence: v32Payload.edges!.confidence,
				provenance: v32Payload.edges!.provenance,
			},
			file_edges: {
				file: v32Payload.file_edges!.file,
				symbol_id: v32Payload.file_edges!.symbol_id,
				count: v32Payload.file_edges!.count,
				kind: [],
			},
			string_table: v32Payload.string_table ?? [],
			edge_source_idx: v32Payload.edge_source_idx ?? [],
			edge_target_idx: v32Payload.edge_target_idx ?? [],
		};
		const v31 = Buffer.concat([CACHE_V3_1_MAGIC, encodeGraphPayloadV31(v31Payload)]);
		const cachePath = join(tmpDir, "v31-with-mtimes.bin");
		writeFileSync(cachePath, v31);

		const loaded = loadGraphCache(cachePath);
		expect(loaded).not.toBeNull();
		expect(loaded!.fileMtimes.get("a.ts")).toBe(12345);
		expect(loaded!.fileMtimes.get("b.ts")).toBe(67890);
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
	it("returns platform-appropriate cache directory", async () => {
		const { CACHE_ROOT } = await import("../core/cache.js");
		const { homedir } = await import("node:os");
		const { join } = await import("node:path");
		// On macOS: ~/Library/Caches/pi-shazam
		// On Linux: $XDG_CACHE_HOME/pi-shazam or ~/.cache/pi-shazam
		// On Windows: %LOCALAPPDATA%/pi-shazam/cache
		expect(CACHE_ROOT).toBeTruthy();
		expect(typeof CACHE_ROOT).toBe("string");
		expect(CACHE_ROOT).toContain("pi-shazam");
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

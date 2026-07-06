/**
 * pi-shazam core/cache -- Graph baseline save/diff for incremental analysis.
 *
 * Provides persistent graph caching with mtime-based invalidation.
 * Stores cache under ~/.cache/repomap/<project-slug> for process-isolated
 * cache directories. Supports V2 serialization with file-level data.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { serializeGraphV2, deserializeGraphV2, createRepoGraph, type Edge, type Provenance } from "./graph.js";
import type { RepoGraph, GraphCacheData as GraphCacheDataExport } from "./graph.js";
import { _logWarn } from "./output.js";
import {
	encodeGraphPayload,
	decodeGraphPayload,
	type ProtoEdgeColumn,
	type ProtoFileEdgeColumn,
	type ProtoGraphPayload,
} from "./proto-schema.js";

// -- Cache directory management -----------------------------------------------

/**
 * Get the platform-appropriate cache root directory.
 *
 * - Windows: %LOCALAPPDATA%\pi-shazam\cache (or %USERPROFILE%\AppData\Local fallback)
 * - macOS: ~/Library/Caches/pi-shazam
 * - Linux: $XDG_CACHE_HOME/pi-shazam (or ~/.cache/pi-shazam fallback)
 */
function getCacheRoot(): string {
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
		return join(localAppData, "pi-shazam", "cache");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Caches", "pi-shazam");
	}
	const xdgCache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(xdgCache, "pi-shazam");
}

export const CACHE_ROOT = getCacheRoot();
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day - prevents stale cache in active projects (fixes #100)
// M2: Shared size limit for cache files - both load and save respect this (prevents OOM on huge projects)
const MAX_CACHE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Get the cache directory for a specific project.
 * Uses SHA-256 hash of canonical path for isolation.
 */
export function getProjectCacheDir(projectPath: string): string {
	// #584: Strip both Unix (/) and Windows (\) trailing separators
	const canonical = projectPath.replace(/[\\/]$/, "");
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
	const projectName = canonical.split("/").pop() || "unknown";
	const cacheDir = join(CACHE_ROOT, `${projectName}_${hash}`);
	try {
		mkdirSync(cacheDir, { recursive: true });
	} catch (err) {
		// Cache directory is a best-effort optimization. If we cannot create it
		// (EACCES, EROFS, ENOSPC, ENAMETOOLONG), degrade gracefully: log a
		// warning and continue without caching. The scan itself still works.
		_logWarn("getProjectCacheDir", `cannot create cache directory ${cacheDir}`, err);
	}
	return cacheDir;
}

// -- Persistent graph cache (V2) ----------------------------------------------

/**
 * Atomically rename a temp file to a target path, handling Windows EPERM/EBUSY
 * by unlinking the target first and retrying.
 */
function atomicRename(tmpPath: string, targetPath: string): void {
	try {
		renameSync(tmpPath, targetPath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EBUSY") {
			try {
				unlinkSync(targetPath);
			} catch (unlinkErr) {
				// ENOENT here is genuinely expected -- the target does not exist
				// yet on the first rename. Only log non-ENOENT failures (#551:
				// blanket global suppression in _logWarn was removed; guard locally).
				if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
					_logWarn("atomicRename", "unlinkSync target failed", unlinkErr);
				}
			}
			renameSync(tmpPath, targetPath);
		} else {
			throw err;
		}
	}
}

/**
 * Save the full graph + file mtimes to a persistent cache file.
 * Uses atomic write (tmp file + rename) to prevent corruption on crash.
 */
export function saveGraphCache(graph: RepoGraph, fileMtimes: Map<string, number>, cachePath: string): void {
	const serialized = serializeGraphV2(graph, fileMtimes);
	mkdirSync(dirname(cachePath), { recursive: true });
	const tmpPath = cachePath + ".tmp";
	try {
		const json = JSON.stringify(serialized);
		// M2: Enforce size limit on save too, not just load — prevents OOM on huge projects.
		// Use Buffer.byteLength to match the byte-count gate at load time (stat.size is in bytes).
		if (Buffer.byteLength(json, "utf-8") > MAX_CACHE_SIZE) {
			_logWarn(
				"saveGraphCache",
				`serialized graph too large (${Buffer.byteLength(json, "utf-8")} bytes), skipping cache`,
			);
			return;
		}
		writeFileSync(tmpPath, json, "utf-8");
		atomicRename(tmpPath, cachePath);
	} catch (err) {
		// Clean up tmp file on failure
		try {
			unlinkSync(tmpPath);
		} catch (cleanupErr) {
			_logWarn("saveGraphCache", "failed to clean up tmp file", cleanupErr);
		}
		throw err;
	}
}

export type GraphCacheData = GraphCacheDataExport;

// -- Persistent graph cache (V3 / ProtoBuf) --------------------------------

/**
 * Magic header for the V3 (ProtoBuf) cache format. Four bytes:
 *   'S' 'H' 'A' '\\3'  -- "SHAzAM v3"
 *
 * The first three bytes spell "SHA" (the project's "Shazam"
 * identity) and the fourth is the format version. The on-disk
 * V2 JSON cache uses an in-band `version: 3` field, so the V3
 * magic byte is intentionally distinct from the JSON version
 * number to avoid confusion in the loader.
 */
export const CACHE_V3_MAGIC: Buffer = Buffer.from([0x53, 0x48, 0x41, 0x03]);

/**
 * #628: serialize a RepoGraph in the compact V3 format. The
 * edge data is encoded as a ProtoBuf `GraphPayload` (columnar
 * source/target/weight/kind/confidence/provenance arrays); the
 * symbol table, fileSymbol index, fileImports, fileImportBindings,
 * fileMtimes, and timestamp are written as a JSON `metadata` blob
 * inside the same payload. The result is prefixed with the V3
 * magic header so the loader can route the file to the right
 * deserializer.
 *
 * Output layout:
 *   [0..3]   magic bytes ("SHA\\3")
 *   [4..N]   ProtoBuf-encoded GraphPayload
 */
export function serializeGraphV3(graph: RepoGraph): Buffer {
	// Build the EdgeColumn from the outgoing map (each edge appears
	// exactly once). We do not need to duplicate into the incoming
	// map on the wire -- the deserializer rebuilds the incoming
	// index from the outgoing rows.
	const edges: ProtoEdgeColumn = { source: [], target: [], weight: [], kind: [], confidence: [], provenance: [] };
	for (const [, edgeList] of graph.outgoing) {
		for (const edge of edgeList) {
			edges.source.push(edge.source);
			edges.target.push(edge.target);
			edges.weight.push(edge.weight);
			edges.kind.push(edge.kind);
			edges.confidence.push(edge.confidence);
			edges.provenance.push(_provenanceToInt(edge.provenance ?? "heuristic"));
		}
	}

	// Build the FileEdgeColumn by concatenating the three file-level
	// maps into a single column. The `kind` field discriminates the
	// map each row came from.
	const fileEdges: ProtoFileEdgeColumn = { file: [], symbol_id: [], count: [], kind: [] };
	// fileCalls rows are stored as [string, number, string]
	// (file path, target symbol id, line, kind). The graph stores
	// them as `[targetSymId, line, kind]` per file. Flatten them.
	for (const [file, calls] of graph.fileCalls) {
		for (const row of calls) {
			const [symId, line, _kind] = row as unknown as [string, number, string];
			fileEdges.file.push(file);
			fileEdges.symbol_id.push(symId);
			fileEdges.count.push(line); // preserve line as the count proxy
			fileEdges.kind.push("call");
		}
	}
	for (const [file, refs] of graph.fileRefs) {
		for (const row of refs) {
			const [symId, line] = row as [string, number];
			fileEdges.file.push(file);
			fileEdges.symbol_id.push(symId);
			fileEdges.count.push(line);
			fileEdges.kind.push("ref");
		}
	}
	for (const [file, typeRefs] of graph.fileTypeRefs) {
		for (const row of typeRefs) {
			const [symId, line] = row as [string, number];
			fileEdges.file.push(file);
			fileEdges.symbol_id.push(symId);
			fileEdges.count.push(line);
			fileEdges.kind.push("typeRef");
		}
	}

	// Metadata: symbols + the small maps that are cheap in JSON.
	const metadata = JSON.stringify({
		symbols: [...graph.symbols.values()].map((s) => ({
			id: s.id,
			name: s.name,
			kind: s.kind,
			file: s.file,
			line: s.line,
			endLine: s.endLine,
			col: s.col,
			visibility: s.visibility,
			signature: s.signature,
			returnType: s.returnType,
			params: s.params,
			docstring: s.docstring,
			pagerank: s.pagerank,
		})),
		fileSymbols: Object.fromEntries(graph.fileSymbols),
		fileImports: Object.fromEntries(graph.fileImports),
		fileImportBindings: Object.fromEntries(
			[...graph.fileImportBindings].map(([k, v]) => [k, v]),
		),
		fileMtimes: {}, // populated by saveGraphCache
		timestamp: Date.now(),
	});

	const payload: ProtoGraphPayload = {
		metadata: new TextEncoder().encode(metadata),
		edges,
		file_edges: fileEdges,
	};

	const protoBytes = encodeGraphPayload(payload);
	// Allocate a single buffer big enough for the magic + payload and
	// copy the proto bytes in after the 4-byte magic header.
	const out = Buffer.allocUnsafe(CACHE_V3_MAGIC.length + protoBytes.length);
	CACHE_V3_MAGIC.copy(out, 0);
	protoBytes.copy(out, CACHE_V3_MAGIC.length);
	return out;
}

/**
 * #628: deserialize a V3 cache buffer into a RepoGraph. Throws if
 * the magic header is missing or the ProtoBuf payload is malformed.
 *
 * Rebuilds the in-memory `incoming` map from the `outgoing` rows
 * so callers can iterate either index without re-deriving.
 */
export function deserializeGraphV3(buffer: Buffer | Uint8Array): RepoGraph {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (buf.length < CACHE_V3_MAGIC.length) {
		throw new Error("deserializeGraphV3: buffer too small for magic header");
	}
	if (!buf.subarray(0, CACHE_V3_MAGIC.length).equals(CACHE_V3_MAGIC)) {
		throw new Error("deserializeGraphV3: missing SHA\\3 magic header (not a V3 cache file)");
	}
	const protoBytes = buf.subarray(CACHE_V3_MAGIC.length);
	if (protoBytes.length === 0) {
		throw new Error("deserializeGraphV3: V3 cache file is empty (no payload after magic header)");
	}
	const payload = decodeGraphPayload(protoBytes);

	// Rebuild the graph. Start with an empty one; populate from the
	// JSON metadata, then attach the symbol-level edges.
	const graph = createRepoGraph();
	if (payload.metadata && payload.metadata.length > 0) {
		const json = new TextDecoder().decode(payload.metadata);
		const meta = JSON.parse(json) as {
			symbols: Array<{
				id: string;
				name: string;
				kind: string;
				file: string;
				line: number;
				endLine?: number;
				col?: number;
				visibility?: string;
				signature?: string;
				returnType?: string;
				params?: string;
				docstring?: string;
				pagerank?: number;
			}>;
			fileSymbols: Record<string, string[]>;
			fileImports: Record<string, string[]>;
			fileImportBindings: Record<string, unknown>;
		};
		for (const s of meta.symbols) {
			const sym: RepoGraph["symbols"] extends Map<string, infer V> ? V : never = {
				id: s.id,
				name: s.name,
				kind: s.kind,
				file: s.file,
				line: s.line,
				endLine: s.endLine ?? s.line,
				col: s.col ?? 0,
				visibility: (s.visibility as "public" | "private" | "exported" | undefined) ?? "public",
				signature: s.signature ?? "",
				returnType: s.returnType ?? "",
				params: s.params ?? "",
				docstring: s.docstring ?? "",
				pagerank: s.pagerank ?? 0,
			} as never;
			graph.symbols.set(s.id, sym);
			const list = graph.nameIndex.get(s.name) ?? [];
			list.push(sym);
			graph.nameIndex.set(s.name, list);
		}
		for (const [file, ids] of Object.entries(meta.fileSymbols)) {
			graph.fileSymbols.set(file, ids);
		}
		for (const [file, imports] of Object.entries(meta.fileImports)) {
			graph.fileImports.set(file, imports);
		}
		// fileImportBindings may not exist on older caches; guard
		// with a type-narrowing check.
		if (meta.fileImportBindings) {
			for (const [file, bindings] of Object.entries(meta.fileImportBindings)) {
				graph.fileImportBindings.set(file, bindings as never);
			}
		}
	}

	// Reconstruct the outgoing + incoming edge maps.
	const edges = payload.edges;
	if (edges && edges.source) {
		const len = edges.source.length;
		for (let i = 0; i < len; i++) {
			const edge: Edge = {
				source: edges.source[i]!,
				target: edges.target[i]!,
				weight: edges.weight[i] ?? 1.0,
				kind: edges.kind[i] ?? "call",
				confidence: edges.confidence[i] ?? 1.0,
				provenance: _provenanceFromInt(edges.provenance[i] ?? 2),
			};
			// Skip dangling edges (defensive: a v3 cache written by a
			// newer schema could reference symbols the loader does
			// not have).
			if (!graph.symbols.has(edge.source) || !graph.symbols.has(edge.target)) {
				continue;
			}
			const out = graph.outgoing.get(edge.source) ?? [];
			out.push(edge);
			graph.outgoing.set(edge.source, out);
			const inc = graph.incoming.get(edge.target) ?? [];
			inc.push(edge);
			graph.incoming.set(edge.target, inc);
		}
	}

	// Reconstruct the file-level edge maps.
	const fileEdges = payload.file_edges;
	if (fileEdges && fileEdges.file) {
		const len = fileEdges.file.length;
		for (let i = 0; i < len; i++) {
			const file = fileEdges.file[i]!;
			const symId = fileEdges.symbol_id[i]!;
			const line = fileEdges.count[i] ?? 0;
			const kind = fileEdges.kind[i]!;
			if (kind === "call") {
				const list = graph.fileCalls.get(file) ?? [];
				list.push([symId, line, "call"] as never);
				graph.fileCalls.set(file, list as never);
			} else if (kind === "ref") {
				const list = graph.fileRefs.get(file) ?? [];
				list.push([symId, line] as never);
				graph.fileRefs.set(file, list as never);
			} else if (kind === "typeRef") {
				const list = graph.fileTypeRefs.get(file) ?? [];
				list.push([symId, line] as never);
				graph.fileTypeRefs.set(file, list as never);
			}
		}
	}

	return graph;
}

/**
 * Map the symbolic `Provenance` strings to the int32 wire values
 * declared in `core/graph.proto`:
 *   0 = resolved, 1 = name_match, 2 = heuristic, 3 = unresolved.
 * Unknown / missing provenance defaults to "heuristic" (2).
 */
function _provenanceToInt(p: Provenance): number {
	switch (p) {
		case "resolved":
			return 0;
		case "name_match":
			return 1;
		case "heuristic":
			return 2;
		case "unresolved":
			return 3;
		default:
			return 2;
	}
}

/** Inverse of `_provenanceToInt`. */
function _provenanceFromInt(n: number): Provenance {
	switch (n) {
		case 0:
			return "resolved";
		case 1:
			return "name_match";
		case 3:
			return "unresolved";
		case 2:
		default:
			return "heuristic";
	}
}

/**
 * Load a persistent graph cache. Returns null if missing, corrupt, wrong
 * version, or older than 1 day.
 */
export function loadGraphCache(cachePath: string): GraphCacheData | null {
	if (!existsSync(cachePath)) return null;
	try {
		const cacheStat = statSync(cachePath);
		if (cacheStat.size > MAX_CACHE_SIZE) {
			_logWarn("loadGraphCache", `cache file too large (${cacheStat.size} bytes), skipping`);
			return null;
		}
		const raw = readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw);
		if (!data || data.version !== 3 || !Array.isArray(data.symbols) || !Array.isArray(data.edges)) return null;
		if (Date.now() - data.timestamp > CACHE_MAX_AGE_MS) return null;

		const graph = deserializeGraphV2(data);
		const fileMtimes = new Map<string, number>();
		for (const [k, v] of Object.entries(data.fileMtimes)) {
			fileMtimes.set(k, v as number);
		}

		return { graph, fileMtimes, timestamp: data.timestamp };
	} catch (err) {
		_logWarn("loadGraphCache", "failed to parse graph cache", err);
		return null;
	}
}

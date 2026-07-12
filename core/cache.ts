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
import {
	serializeGraphV2 as _serializeGraphV2,
	deserializeGraphV2,
	createRepoGraph,
	type Edge,
	type Provenance,
} from "./graph.js";
import type { RepoGraph, GraphCacheData as GraphCacheDataExport } from "./graph.js";
import { _logWarn } from "./output.js";
import {
	encodeGraphPayload,
	decodeGraphPayload,
	decodeGraphPayloadV31,
	type ProtoEdgeColumn,
	type ProtoFileEdgeColumn,
	type ProtoGraphPayload,
	type ProtoGraphPayloadV31,
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
	// Cross-platform-safe project name: Node's path.basename mis-parses
	// Windows drive-prefixed backslash paths (e.g. `C:\a\b\proj` is treated
	// as a relative `C:` path and yields garbage), so strip the drive prefix
	// and unify separators to `/` before taking the last segment.
	const normalized = canonical.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/");
	const projectName = normalized.split("/").pop() || "unknown";
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

export interface CacheSaveResult {
	persisted: boolean;
	reason?: "oversized" | "error";
	errorMessage?: string;
	sizeBytes?: number;
	maxBytes?: number;
}

/**
 * Save the full graph + file mtimes to a persistent cache file.
 * Uses atomic write (tmp file + rename) to prevent corruption on crash.
 *
 * Writes the V3 (ProtoBuf) format by default. The V2 (JSON) format
 * is still readable via `loadGraphCache` for backward compatibility
 * with caches written by older pi-shazam versions.
 *
 * Returns a CacheSaveResult indicating whether the cache was persisted
 * and, if not, why. Never throws — failures are captured in the result
 * so the caller can propagate degraded-mode status to the user.
 */
export function saveGraphCache(graph: RepoGraph, fileMtimes: Map<string, number>, cachePath: string): CacheSaveResult {
	// #628: emit the V3 (ProtoBuf) format. The serialized buffer
	// is ~30% smaller than the equivalent JSON for a 1000-symbol
	// graph and decodes in comparable time.
	const buf = serializeGraphV3(graph, fileMtimes);
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
	} catch (err) {
		_logWarn("saveGraphCache", `cannot create cache directory ${dirname(cachePath)}`, err);
		return { persisted: false, reason: "error", errorMessage: (err as Error).message };
	}
	const tmpPath = cachePath + ".tmp";
	try {
		if (buf.length > MAX_CACHE_SIZE) {
			_logWarn("saveGraphCache", `serialized graph too large (${buf.length} bytes), skipping cache`);
			return { persisted: false, reason: "oversized", sizeBytes: buf.length, maxBytes: MAX_CACHE_SIZE };
		}
		writeFileSync(tmpPath, buf);
		atomicRename(tmpPath, cachePath);
		return { persisted: true, sizeBytes: buf.length };
	} catch (err) {
		// Clean up tmp file on failure
		try {
			unlinkSync(tmpPath);
		} catch (cleanupErr) {
			_logWarn("saveGraphCache", "failed to clean up tmp file", cleanupErr);
		}
		_logWarn("saveGraphCache", "failed to persist graph cache", err);
		return { persisted: false, reason: "error", errorMessage: (err as Error).message };
	}
}

export type GraphCacheData = GraphCacheDataExport;

// -- Persistent graph cache (V3 / ProtoBuf) --------------------------------

/**
 * Magic header for the V3 (ProtoBuf) cache format. Four bytes:
 *   'S' 'H' 'A' '\\5'  -- "SHAzAM v3.2"
 *
 * The first three bytes spell "SHA" (the project's "Shazam"
 * identity) and the fourth is the format version. The on-disk
 * V2 JSON cache uses an in-band `version: 3` field, so the V3
 * magic byte is intentionally distinct from the JSON version
 * number to avoid confusion in the loader.
 *
 * Issue #647 (V3.1, magic 0x04): added a string table that
 * dedupes symbol IDs across edges.
 * Issue #647 (V3.2, magic 0x05): encoded `EdgeColumn.kind` and
 * `FileEdgeColumn.kind` as int32 instead of string, saving another
 * ~30-50 KB on real-world projects. Old V3.0 (0x03) and V3.1 (0x04)
 * caches are routed through dedicated deserializers and re-encoded
 * as V3.2 on first load (`loadGraphCache` does this in-place when
 * the cache path is writable); the scanner rebuilds them on the
 * next save. No user-facing re-scan cost on upgrade.
 */
export const CACHE_V3_MAGIC: Buffer = Buffer.from([0x53, 0x48, 0x41, 0x05]);

/**
 * Magic header for the V3.1 (ProtoBuf with string table) format.
 * 'S' 'H' 'A' '\\4'. Kept as a separate constant so `loadGraphCache`
 * can route 0x04 buffers to a V3.1 reader that handles the older
 * `kind` string encoding, then re-encode as V3.2.
 */
export const CACHE_V3_1_MAGIC: Buffer = Buffer.from([0x53, 0x48, 0x41, 0x04]);

/**
 * Magic header for the V3.0 (ProtoBuf columnar, no string table)
 * format. 'S' 'H' 'A' '\\3'. Kept for the same reason as
 * CACHE_V3_1_MAGIC -- users on v0.27.0 (PR-G) shipped this format.
 */
export const CACHE_V3_0_MAGIC: Buffer = Buffer.from([0x53, 0x48, 0x41, 0x03]);

/**
 * #628 + #647: serialize a RepoGraph in the compact V3.2 format. The
 * edge data is encoded as a ProtoBuf `GraphPayload` (columnar
 * weight/kind/confidence/provenance arrays plus int32 source/target
 * indices into a top-level `string_table`); the symbol table,
 * fileSymbol index, fileImports, fileImportBindings, fileMtimes, and
 * timestamp are written as a JSON `metadata` blob inside the same
 * payload. The result is prefixed with the V3.2 magic header so the
 * loader can route the file to the right deserializer.
 *
 * V3.1 (issue #647): symbol IDs are deduped into a top-level
 * `string_table`; each edge's `source` / `target` are stored as
 * int32 indices into that table. The `EdgeColumn.source` /
 * `EdgeColumn.target` repeated-string fields stay empty in V3.1+
 * (kept in the schema for forward-compat).
 *
 * V3.2 (issue #647, follow-up D): `kind` is int32 instead of string
 * (1 byte varint vs. 5-7 bytes per row). See `_kindToInt` for the
 * mapping.
 *
 * Output layout:
 *   [0..3]   magic bytes ("SHA\\5")
 *   [4..N]   ProtoBuf-encoded GraphPayload
 */
export function serializeGraphV3(graph: RepoGraph, fileMtimes?: Map<string, number>): Buffer {
	// Build the EdgeColumn from the outgoing map (each edge appears
	// exactly once). We do not need to duplicate into the incoming
	// map on the wire -- the deserializer rebuilds the incoming
	// index from the outgoing rows.
	//
	// V3.1: parallel `edge_source_idx` / `edge_target_idx` arrays
	// hold int32 indices into `string_table`. The first occurrence
	// of each unique ID gets a fresh index; subsequent occurrences
	// reuse it. Edge iteration order matches `graph.outgoing` so
	// the indices are deterministic for a given graph state.
	const edges: ProtoEdgeColumn = { source: [], target: [], weight: [], kind: [], confidence: [], provenance: [] };
	const stringTable: string[] = [];
	const stringToIdx = new Map<string, number>();
	const edgeSourceIdx: number[] = [];
	const edgeTargetIdx: number[] = [];
	// `intern` returns the index of `id` in `stringTable`, adding
	// the ID on first encounter. Map preserves insertion order so
	// the resulting string table is deterministic.
	const intern = (id: string): number => {
		const existing = stringToIdx.get(id);
		if (existing !== undefined) return existing;
		const idx = stringTable.length;
		stringTable.push(id);
		stringToIdx.set(id, idx);
		return idx;
	};
	for (const [, edgeList] of graph.outgoing) {
		for (const edge of edgeList) {
			// weight / confidence / provenance are kept as parallel
			// arrays because they don't dedupe well (mostly small
			// numerics with high cardinality). `kind` is V3.2 int32
			// (1 byte varint vs. 5-7 byte string). source / target
			// are NOT pushed to `edges` here -- V3.1+ uses the
			// index columns below for those.
			edges.weight.push(edge.weight);
			edges.kind.push(_kindToInt(edge.kind));
			edges.confidence.push(edge.confidence);
			edges.provenance.push(_provenanceToInt(edge.provenance ?? "heuristic"));
			edgeSourceIdx.push(intern(edge.source));
			edgeTargetIdx.push(intern(edge.target));
		}
	}

	// Build the FileEdgeColumn by concatenating the three file-level
	// maps into a single column. The `kind` field discriminates the
	// map each row came from. File paths are mostly unique already,
	// so no string table is used here (see issue #647 "out of scope").
	// `kind` is V3.2 int32.
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
			fileEdges.kind.push(KIND_CALL);
		}
	}
	for (const [file, refs] of graph.fileRefs) {
		for (const row of refs) {
			const [symId, line] = row as [string, number];
			fileEdges.file.push(file);
			fileEdges.symbol_id.push(symId);
			fileEdges.count.push(line);
			fileEdges.kind.push(KIND_REF);
		}
	}
	for (const [file, typeRefs] of graph.fileTypeRefs) {
		for (const row of typeRefs) {
			const [symId, line] = row as [string, number];
			fileEdges.file.push(file);
			fileEdges.symbol_id.push(symId);
			fileEdges.count.push(line);
			fileEdges.kind.push(KIND_TYPE_REF);
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
		fileImportBindings: Object.fromEntries([...graph.fileImportBindings].map(([k, v]) => [k, v])),
		// Carry the fileMtimes through to the loader so the
		// mtime-based cache invalidation in scanProject() can run
		// against V3 caches as well.
		fileMtimes: fileMtimes ? Object.fromEntries(fileMtimes) : {},
		timestamp: Date.now(),
	});

	const payload: ProtoGraphPayload = {
		metadata: new TextEncoder().encode(metadata),
		edges,
		file_edges: fileEdges,
		// V3.1 string table + per-edge index columns. These
		// fields are optional in the wire type but always populated
		// by this writer.
		string_table: stringTable,
		edge_source_idx: edgeSourceIdx,
		edge_target_idx: edgeTargetIdx,
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
 * #628: like `deserializeGraphV3` but also returns the parsed
 * metadata JSON (fileMtimes + timestamp). Used by `loadGraphCache`
 * to recover those fields without re-decoding the whole graph.
 */
export function deserializeGraphV3WithMetadata(buffer: Buffer | Uint8Array): {
	graph: RepoGraph;
	metadata: { fileMtimes?: Record<string, number>; timestamp?: number };
} {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (buf.length < CACHE_V3_MAGIC.length) {
		throw new Error("deserializeGraphV3WithMetadata: buffer too small for magic header");
	}
	if (!buf.subarray(0, CACHE_V3_MAGIC.length).equals(CACHE_V3_MAGIC)) {
		throw new Error("deserializeGraphV3WithMetadata: missing SHA\\5 magic header");
	}
	const protoBytes = buf.subarray(CACHE_V3_MAGIC.length);
	const payload = decodeGraphPayload(protoBytes);
	const metadata: { fileMtimes?: Record<string, number>; timestamp?: number } = {};
	if (payload.metadata && payload.metadata.length > 0) {
		try {
			const json = new TextDecoder().decode(payload.metadata);
			const parsed = JSON.parse(json) as { fileMtimes?: Record<string, number>; timestamp?: number };
			metadata.fileMtimes = parsed.fileMtimes;
			metadata.timestamp = parsed.timestamp;
		} catch (err) {
			// Metadata parse failure is non-fatal; the graph itself
			// is still deserialized below. We log the failure so
			// future debugging can find it but do not propagate
			// because the cache file may simply pre-date the
			// fileMtimes/timestamp fields.
			_logWarn("deserializeGraphV3WithMetadata", "failed to parse V3 metadata JSON", err);
		}
	}
	const graph = deserializeGraphV3(buf);
	return { graph, metadata };
}

/**
 * V3.2 (issue #647 + follow-up D): deserialize a V3.2 cache buffer
 * into a RepoGraph. Throws if the magic header is missing or the
 * ProtoBuf payload is malformed. `kind` is int32 (V3.2); source /
 * target come from the top-level `string_table` via the parallel
 * index arrays.
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
		throw new Error(`deserializeGraphV3: missing ${CACHE_V3_MAGIC.toString("hex")} magic header (not a V3 cache file)`);
	}
	const protoBytes = buf.subarray(CACHE_V3_MAGIC.length);
	if (protoBytes.length === 0) {
		throw new Error("deserializeGraphV3: V3 cache file is empty (no payload after magic header)");
	}
	const payload = decodeGraphPayload(protoBytes);
	const graph = createRepoGraph();
	_rebuildMetadataV32(payload, graph);
	_rebuildEdgesV32(payload, graph);
	_rebuildFileEdgesV32(payload, graph);
	return graph;
}

/**
 * V3.1 (issue #647, first wire-format bump): reads a V3.1 buffer
 * (magic 0x04) where `kind` is still a string and source / target
 * come from the string table. Used by `loadGraphCache` to convert
 * a V3.1 cache to V3.2 in place on first load.
 *
 * The V3.1 wire format uses `repeated string kind` -- a different
 * proto wire type than V3.2's `repeated int32 kind`. We therefore
 * decode with the V3.1-specific schema (`decodeGraphPayloadV31`)
 * and then convert each string to its int code in the edge rebuild
 * (so the in-memory graph keeps using string kinds, matching the
 * `Edge.kind: string` contract in `core/graph.ts`).
 */
export function deserializeGraphV3V1(buffer: Buffer | Uint8Array): RepoGraph {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (buf.length < CACHE_V3_1_MAGIC.length) {
		throw new Error("deserializeGraphV3V1: buffer too small for magic header");
	}
	if (!buf.subarray(0, CACHE_V3_1_MAGIC.length).equals(CACHE_V3_1_MAGIC)) {
		throw new Error(
			`deserializeGraphV3V1: missing ${CACHE_V3_1_MAGIC.toString("hex")} magic header (not a V3.1 cache file)`,
		);
	}
	const protoBytes = buf.subarray(CACHE_V3_1_MAGIC.length);
	if (protoBytes.length === 0) {
		throw new Error("deserializeGraphV3V1: V3.1 cache file is empty (no payload after magic header)");
	}
	const payload = decodeGraphPayloadV31(protoBytes);
	const graph = createRepoGraph();
	_rebuildMetadataV31(payload, graph);
	_rebuildEdgesV31(payload, graph);
	_rebuildFileEdgesV31(payload, graph);
	return graph;
}

/**
 * V3.1 (issue #647, first wire-format bump): reads a V3.1 buffer
 * (magic 0x04) where `kind` is still a string and source / target
 * come from the string table. Used by `loadGraphCache` to convert
 * a V3.1 cache to V3.2 in place on first load.
 *
 * The V3.1 wire format uses `repeated string kind` -- a different
 * proto wire type than V3.2's `repeated int32 kind`. We therefore
 * decode with the V3.1-specific schema (`decodeGraphPayloadV31`)
 * and then convert each string to its int code in the edge rebuild
 * (so the in-memory graph keeps using string kinds, matching the
 * `Edge.kind: string` contract in `core/graph.ts`).
 */
export function deserializeGraphV3V1WithMetadata(buffer: Buffer | Uint8Array): {
	graph: RepoGraph;
	metadata: { fileMtimes?: Record<string, number>; timestamp?: number };
} {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (buf.length < CACHE_V3_1_MAGIC.length) {
		throw new Error("deserializeGraphV3V1WithMetadata: buffer too small for magic header");
	}
	if (!buf.subarray(0, CACHE_V3_1_MAGIC.length).equals(CACHE_V3_1_MAGIC)) {
		throw new Error("deserializeGraphV3V1WithMetadata: missing SHA\\4 magic header");
	}
	const protoBytes = buf.subarray(CACHE_V3_1_MAGIC.length);
	const payload = decodeGraphPayloadV31(protoBytes);
	const graph = createRepoGraph();
	_rebuildMetadataV31(payload, graph);
	_rebuildEdgesV31(payload, graph);
	_rebuildFileEdgesV31(payload, graph);
	const metadata = _extractV3Metadata(payload.metadata);
	return { graph, metadata };
}

/**
 * V3.0 (issue #628 original release): reads a V3.0 buffer (magic
 * 0x03) where `kind` is a string and source / target live inline
 * on the EdgeColumn (no string table yet). Kept around so users on
 * v0.27.0 (PR-G) caches can be loaded + converted to V3.2 by
 * `loadGraphCache` without a re-scan.
 *
 * V3.0's wire format has no string table; the V3.0 reader pulls
 * source / target from the inline `edges.source` / `edges.target`
 * fields on the ProtoBuf message. We use the V3.1-specific
 * decoder because the field types (string kind, no string table
 * on GraphPayload) are wire-compatible -- the V3.0 buffer just
 * leaves `string_table` / `edge_source_idx` / `edge_target_idx`
 * empty, which the V3.0 reader simply ignores.
 */
export function deserializeGraphV3V0WithMetadata(buffer: Buffer | Uint8Array): {
	graph: RepoGraph;
	metadata: { fileMtimes?: Record<string, number>; timestamp?: number };
} {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (buf.length < CACHE_V3_0_MAGIC.length) {
		throw new Error("deserializeGraphV3V0WithMetadata: buffer too small for magic header");
	}
	if (!buf.subarray(0, CACHE_V3_0_MAGIC.length).equals(CACHE_V3_0_MAGIC)) {
		throw new Error("deserializeGraphV3V0WithMetadata: missing SHA\\3 magic header");
	}
	const protoBytes = buf.subarray(CACHE_V3_0_MAGIC.length);
	const payload = decodeGraphPayloadV31(protoBytes);
	const graph = createRepoGraph();
	_rebuildMetadataV31(payload, graph);
	_rebuildEdgesV30(payload, graph);
	_rebuildFileEdgesV30(payload, graph);
	const metadata = _extractV3Metadata(payload.metadata);
	return { graph, metadata };
}

/**
 * Extract the `fileMtimes` + `timestamp` fields from a V3 metadata
 * JSON blob. Returns empty maps / current time on parse failure
 * (non-fatal -- the cache may pre-date these fields).
 */
function _extractV3Metadata(metadataBytes: Uint8Array): {
	fileMtimes?: Record<string, number>;
	timestamp?: number;
} {
	const result: { fileMtimes?: Record<string, number>; timestamp?: number } = {};
	if (!metadataBytes || metadataBytes.length === 0) return result;
	try {
		const json = new TextDecoder().decode(metadataBytes);
		const parsed = JSON.parse(json) as { fileMtimes?: Record<string, number>; timestamp?: number };
		result.fileMtimes = parsed.fileMtimes;
		result.timestamp = parsed.timestamp;
	} catch (err) {
		_logWarn("_extractV3Metadata", "failed to parse V3 metadata JSON", err);
	}
	return result;
}

/**
 * V3.0 (issue #628 original release): reads a V3.0 buffer (magic
 * 0x03) where `kind` is a string and source / target live inline
 * on the EdgeColumn (no string table yet). Kept around so users on
 * v0.27.0 (PR-G) caches can be loaded + converted to V3.2 by
 * `loadGraphCache` without a re-scan.
 */
export function deserializeGraphV3V0(buffer: Buffer | Uint8Array): RepoGraph {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (buf.length < CACHE_V3_0_MAGIC.length) {
		throw new Error("deserializeGraphV3V0: buffer too small for magic header");
	}
	if (!buf.subarray(0, CACHE_V3_0_MAGIC.length).equals(CACHE_V3_0_MAGIC)) {
		throw new Error(
			`deserializeGraphV3V0: missing ${CACHE_V3_0_MAGIC.toString("hex")} magic header (not a V3.0 cache file)`,
		);
	}
	const protoBytes = buf.subarray(CACHE_V3_0_MAGIC.length);
	if (protoBytes.length === 0) {
		throw new Error("deserializeGraphV3V0: V3.0 cache file is empty (no payload after magic header)");
	}
	const payload = decodeGraphPayloadV31(protoBytes);
	const graph = createRepoGraph();
	_rebuildMetadataV31(payload, graph);
	_rebuildEdgesV30(payload, graph);
	_rebuildFileEdgesV30(payload, graph);
	return graph;
}

/**
 * Rebuild metadata from a V3.1-decoded payload. The metadata blob
 * format is stable across V3.0 / V3.1 / V3.2 so this is identical
 * to the V3.2 path; the only difference is the input type
 * (`ProtoGraphPayloadV31` instead of `ProtoGraphPayload`).
 */
function _rebuildMetadataV31(payload: ProtoGraphPayloadV31, graph: RepoGraph): void {
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
		if (meta.fileImportBindings) {
			for (const [file, bindings] of Object.entries(meta.fileImportBindings)) {
				graph.fileImportBindings.set(file, bindings as never);
			}
		}
	}
}

/**
 * Rebuild the symbol table + file-level index maps from the
 * ProtoBuf `metadata` bytes. Identical across V3.0 / V3.1 / V3.2 --
 * the metadata format is stable. Takes the V3.2-typed payload
 * (`ProtoGraphPayload`); the V3.1 / V3.0 readers in this file use
 * a parallel `_rebuildMetadataV31` for the V3.1-typed payload.
 */
function _rebuildMetadataV32(payload: ProtoGraphPayload, graph: RepoGraph): void {
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
}

/** Append one edge to the outgoing + incoming indexes, skipping dangling targets. */
function _appendEdge(graph: RepoGraph, edge: Edge): void {
	if (!graph.symbols.has(edge.source) || !graph.symbols.has(edge.target)) {
		return;
	}
	const out = graph.outgoing.get(edge.source) ?? [];
	out.push(edge);
	graph.outgoing.set(edge.source, out);
	const inc = graph.incoming.get(edge.target) ?? [];
	inc.push(edge);
	graph.incoming.set(edge.target, inc);
	// Reverse-edge index: required by _cleanEdgesForSymbols (scanner.ts:339).
	// Without this, the incremental scan after a V3 cache load cannot clean
	// cross-file edges pointing at changed-file symbols, corrupting
	// shazam_impact blast radius and PageRank. Mirrors addEdge (scanner.ts:1242).
	const sources = graph.targetToSources.get(edge.target);
	if (sources) {
		sources.add(edge.source);
	} else {
		graph.targetToSources.set(edge.target, new Set([edge.source]));
	}
}

/**
 * V3.2 edge rebuild: `kind` is int32, source / target come from
 * the string table via the parallel index columns.
 */
function _rebuildEdgesV32(payload: ProtoGraphPayload, graph: RepoGraph): void {
	const edges = payload.edges;
	const stringTable = payload.string_table ?? [];
	const sourceIdx = payload.edge_source_idx ?? [];
	const targetIdx = payload.edge_target_idx ?? [];
	if (!edges || sourceIdx.length === 0) return;
	const len = sourceIdx.length;
	if (targetIdx.length !== len) {
		throw new Error(
			`deserializeGraphV3: edge_source_idx (${len}) and edge_target_idx (${targetIdx.length}) length mismatch`,
		);
	}
	for (let i = 0; i < len; i++) {
		const srcIdx = sourceIdx[i]!;
		const tgtIdx = targetIdx[i]!;
		if (srcIdx < 0 || srcIdx >= stringTable.length || tgtIdx < 0 || tgtIdx >= stringTable.length) {
			_logWarn(
				"deserializeGraphV3",
				`edge ${i} has out-of-range string table index (src=${srcIdx}, tgt=${tgtIdx}, table size=${stringTable.length}); skipping`,
			);
			continue;
		}
		_appendEdge(graph, {
			source: stringTable[srcIdx]!,
			target: stringTable[tgtIdx]!,
			weight: edges.weight[i] ?? 1.0,
			kind: _intToKind(edges.kind[i] ?? 0),
			confidence: edges.confidence[i] ?? 1.0,
			provenance: _provenanceFromInt(edges.provenance[i] ?? 2),
		});
	}
}

/**
 * V3.1 edge rebuild: `kind` is a string (decoded via the V3.1-
 * specific schema), source / target come from the string table
 * via the parallel index columns. Used by the V3.1 -> V3.2
 * in-place converter in `loadGraphCache`.
 */
function _rebuildEdgesV31(payload: ProtoGraphPayloadV31, graph: RepoGraph): void {
	const edges = payload.edges;
	const stringTable = payload.string_table ?? [];
	const sourceIdx = payload.edge_source_idx ?? [];
	const targetIdx = payload.edge_target_idx ?? [];
	if (!edges || sourceIdx.length === 0) return;
	const len = sourceIdx.length;
	if (targetIdx.length !== len) {
		throw new Error(
			`deserializeGraphV3V1: edge_source_idx (${len}) and edge_target_idx (${targetIdx.length}) length mismatch`,
		);
	}
	for (let i = 0; i < len; i++) {
		const srcIdx = sourceIdx[i]!;
		const tgtIdx = targetIdx[i]!;
		if (srcIdx < 0 || srcIdx >= stringTable.length || tgtIdx < 0 || tgtIdx >= stringTable.length) {
			_logWarn(
				"deserializeGraphV3V1",
				`edge ${i} has out-of-range string table index (src=${srcIdx}, tgt=${tgtIdx}, table size=${stringTable.length}); skipping`,
			);
			continue;
		}
		_appendEdge(graph, {
			source: stringTable[srcIdx]!,
			target: stringTable[tgtIdx]!,
			weight: edges.weight[i] ?? 1.0,
			// V3.1: kind is a string. Pass through to the in-memory
			// `Edge.kind: string` contract; unknown values default to
			// "call" via `_kindToInt` round-trip in the V3.2 writer
			// (we re-encode with V3.2, which calls _kindToInt again).
			kind: edges.kind[i] ?? "call",
			confidence: edges.confidence[i] ?? 1.0,
			provenance: _provenanceFromInt(edges.provenance[i] ?? 2),
		});
	}
}

/**
 * V3.0 edge rebuild: no string table; source / target come from
 * the inline `edges.source` / `edges.target` fields. `kind` is a
 * string. Used to convert pre-#647 (v0.27.0 PR-G) caches.
 */
function _rebuildEdgesV30(payload: ProtoGraphPayloadV31, graph: RepoGraph): void {
	const edges = payload.edges;
	if (!edges || !edges.source || edges.source.length === 0) return;
	const len = edges.source.length;
	if ((edges.target?.length ?? 0) !== len) {
		throw new Error(
			`deserializeGraphV3V0: edges.source (${len}) and edges.target (${edges.target?.length ?? 0}) length mismatch`,
		);
	}
	for (let i = 0; i < len; i++) {
		_appendEdge(graph, {
			source: edges.source[i]!,
			target: edges.target![i]!,
			weight: edges.weight[i] ?? 1.0,
			kind: edges.kind[i] ?? "call",
			confidence: edges.confidence[i] ?? 1.0,
			provenance: _provenanceFromInt(edges.provenance[i] ?? 2),
		});
	}
}

/**
 * File-level edge rebuild (V3.2): `kind` is int32.
 */
function _rebuildFileEdgesV32(payload: ProtoGraphPayload, graph: RepoGraph): void {
	const fileEdges = payload.file_edges;
	if (!fileEdges || !fileEdges.file) return;
	const len = fileEdges.file.length;
	for (let i = 0; i < len; i++) {
		const file = fileEdges.file[i]!;
		const symId = fileEdges.symbol_id[i]!;
		const line = fileEdges.count[i] ?? 0;
		const kind = _intToKind(fileEdges.kind[i] ?? 0);
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

/** File-level edge rebuild (V3.1): `kind` is a string. */
function _rebuildFileEdgesV31(payload: ProtoGraphPayloadV31, graph: RepoGraph): void {
	const fileEdges = payload.file_edges;
	if (!fileEdges || !fileEdges.file) return;
	const len = fileEdges.file.length;
	for (let i = 0; i < len; i++) {
		const file = fileEdges.file[i]!;
		const symId = fileEdges.symbol_id[i]!;
		const line = fileEdges.count[i] ?? 0;
		const kind = fileEdges.kind[i] ?? "call";
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

/** File-level edge rebuild (V3.0): `kind` is a string. */
function _rebuildFileEdgesV30(payload: ProtoGraphPayloadV31, graph: RepoGraph): void {
	// V3.0 file-level rebuild is identical to V3.1 (both use kind
	// as string); the dispatcher still routes them separately so
	// future changes can be version-specific.
	_rebuildFileEdgesV31(payload, graph);
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
 * V3.2 (issue #647, follow-up D): map edge kind strings to int32
 * wire values declared in `core/graph.proto`:
 *   0 = "call"          (most common; default for unknown)
 *   1 = "type"
 *   2 = "import"
 *   3 = "ref"
 *   4 = "typeRef"
 *   5 = "import-binding"
 * Unknown / missing kind defaults to "call" (0) -- it's the most
 * common value and a safe fallback. The "call" / "ref" / "typeRef"
 * set is used by file-level edges; "call" / "type" / "import" /
 * "ref" / "import-binding" by symbol-level edges.
 */
export const KIND_CALL = 0;
export const KIND_TYPE = 1;
export const KIND_IMPORT = 2;
export const KIND_REF = 3;
export const KIND_TYPE_REF = 4;
export const KIND_IMPORT_BINDING = 5;

function _kindToInt(k: string): number {
	switch (k) {
		case "call":
			return KIND_CALL;
		case "type":
			return KIND_TYPE;
		case "import":
			return KIND_IMPORT;
		case "ref":
			return KIND_REF;
		case "typeRef":
			return KIND_TYPE_REF;
		case "import-binding":
			return KIND_IMPORT_BINDING;
		default:
			return KIND_CALL;
	}
}

function _intToKind(n: number): string {
	switch (n) {
		case KIND_CALL:
			return "call";
		case KIND_TYPE:
			return "type";
		case KIND_IMPORT:
			return "import";
		case KIND_REF:
			return "ref";
		case KIND_TYPE_REF:
			return "typeRef";
		case KIND_IMPORT_BINDING:
			return "import-binding";
		default:
			return "call";
	}
}

/**
 * Load a persistent graph cache. Returns null if missing, corrupt, wrong
 * version, or older than 1 day.
 *
 * Reads the V3 (ProtoBuf) format first; falls back to V2 (JSON) when
 * the file lacks the V3 magic header so caches written by older
 * pi-shazam versions continue to load.
 *
 * Issue #647 (follow-up E): legacy V3.0 (magic 0x03, pre-string-
 * table) and V3.1 (magic 0x04, kind as string) caches are
 * automatically converted to V3.2 in place on first load. The
 * reader extracts the graph + fileMtimes, then `saveGraphCache`
 * re-encodes as V3.2 and atomically replaces the on-disk file.
 * This avoids a full re-scan on upgrade for users coming from
 * v0.27.0 (V3.0) or the just-shipped V3.1 release of this branch.
 */
export function loadGraphCache(cachePath: string): GraphCacheData | null {
	if (!existsSync(cachePath)) return null;
	try {
		const cacheStat = statSync(cachePath);
		if (cacheStat.size > MAX_CACHE_SIZE) {
			_logWarn("loadGraphCache", `cache file too large (${cacheStat.size} bytes), skipping`);
			return null;
		}
		const buf = readFileSync(cachePath);
		// #628: try V3 (ProtoBuf) first by checking the magic header.
		// Falls back to V2 (JSON) when the file is not a V3 cache --
		// preserves backward compat for caches written by pre-#628
		// pi-shazam versions.
		if (buf.length >= CACHE_V3_MAGIC.length && buf.subarray(0, CACHE_V3_MAGIC.length).equals(CACHE_V3_MAGIC)) {
			const { graph, metadata } = deserializeGraphV3WithMetadata(buf);
			const fileMtimes = new Map<string, number>();
			for (const [k, v] of Object.entries(metadata.fileMtimes ?? {})) {
				fileMtimes.set(k, v as number);
			}
			return { graph, fileMtimes, timestamp: metadata.timestamp ?? Date.now() };
		}
		// V3.1 (magic 0x04, this branch's first-pass release): convert
		// to V3.2 in place. The reader uses the V3.1-specific schema
		// (kind as string) so the wire bytes decode correctly; the
		// resulting RepoGraph is re-encoded with the V3.2 writer
		// (kind as int) and atomically replaces the on-disk file.
		if (buf.length >= CACHE_V3_1_MAGIC.length && buf.subarray(0, CACHE_V3_1_MAGIC.length).equals(CACHE_V3_1_MAGIC)) {
			const { graph, metadata } = deserializeGraphV3V1WithMetadata(buf);
			const fileMtimes = new Map<string, number>();
			for (const [k, v] of Object.entries(metadata.fileMtimes ?? {})) {
				fileMtimes.set(k, v as number);
			}
			_upgradeV3CacheInPlace(cachePath, graph, fileMtimes, "V3.1");
			return { graph, fileMtimes, timestamp: metadata.timestamp ?? Date.now() };
		}
		// V3.0 (magic 0x03, v0.27.0 PR-G): convert to V3.2 in place.
		// The reader pulls source / target from the inline EdgeColumn
		// fields (no string table) and decodes `kind` as a string,
		// then the V3.2 writer re-encodes everything.
		if (buf.length >= CACHE_V3_0_MAGIC.length && buf.subarray(0, CACHE_V3_0_MAGIC.length).equals(CACHE_V3_0_MAGIC)) {
			const { graph, metadata } = deserializeGraphV3V0WithMetadata(buf);
			const fileMtimes = new Map<string, number>();
			for (const [k, v] of Object.entries(metadata.fileMtimes ?? {})) {
				fileMtimes.set(k, v as number);
			}
			_upgradeV3CacheInPlace(cachePath, graph, fileMtimes, "V3.0");
			return { graph, fileMtimes, timestamp: metadata.timestamp ?? Date.now() };
		}
		// V2 fallback path
		const raw = buf.toString("utf-8");
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

/**
 * Replace an on-disk V3.0 / V3.1 cache with the V3.2 equivalent.
 * The decoded graph + fileMtimes are re-serialized via
 * `saveGraphCache`, which writes to a tmp file and atomically
 * renames over the original. On any failure the warning is
 * logged but the original (legacy) file is left in place -- the
 * caller still returns the decoded graph so the current run is
 * unaffected. The next `loadGraphCache` call will retry the
 * upgrade.
 */
function _upgradeV3CacheInPlace(
	cachePath: string,
	graph: RepoGraph,
	fileMtimes: Map<string, number>,
	fromVersion: "V3.0" | "V3.1",
): void {
	try {
		// `saveGraphCache` overwrites the file at `cachePath`.
		// The original magic was 0x03 / 0x04; the new file will
		// be 0x05. Atomic rename is handled inside saveGraphCache
		// (see `atomicRename`).
		saveGraphCache(graph, fileMtimes, cachePath);
	} catch (err) {
		// Failure to upgrade is non-fatal. The in-memory graph is
		// still returned to the caller, and the next load will
		// retry. The legacy cache stays on disk until a future
		// successful save.
		_logWarn(
			"loadGraphCache",
			`failed to upgrade ${fromVersion} cache to V3.2 in place; legacy file left unchanged`,
			err,
		);
	}
}

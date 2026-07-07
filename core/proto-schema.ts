/**
 * pi-shazam core/proto-schema -- ProtoBuf schema for the V3 graph cache.
 *
 * Issue #628: compact columnar ProtoBuf encoding for the on-disk
 * graph cache. The V2 JSON format is dense and produces ~800KB files
 * for a 1000-symbol project; this module gives the V3 cache a binary
 * wire format that compresses the same edge data by 50-70%.
 *
 * Issue #647: V3.1 adds a top-level string table that dedupes
 * symbol IDs across every edge. Each unique ID is written once
 * into `string_table`; each edge's source / target is referenced
 * by int32 index. On a 1000-symbol / ~3000-edge graph this cuts
 * the on-disk V3 cache by ~80KB (~20% additional reduction) on
 * top of the columnar encoding, bringing V3 to ~50% of V2.
 *
 * Issue #647 (follow-up D, V3.2): `kind` is int32 instead of string
 * (1 byte varint vs. 5-7 bytes per row).
 *
 * The runtime uses the `protobufjs` library with JSON schemas
 * defined inline (mirroring `core/graph.proto`). Defining the
 * schema as JSON in code avoids a build step + ~70KB of generated
 * static module that would otherwise ship in `dist/`. The
 * `core/graph.proto` file remains the canonical source of truth
 * for the schema and is what external tools (e.g. language
 * bindings) should consume.
 *
 * The schema is intentionally narrow: only the edge maps
 * (incoming / outgoing / fileCalls / fileRefs / fileTypeRefs)
 * are encoded in ProtoBuf. Symbols and fileSymbols stay in JSON
 * (stored as the `metadata` bytes field) because they are few and
 * their per-string overhead would dominate the binary encoding.
 */
import protobuf from "protobufjs";

/**
 * V3.2 ProtoBuf root namespace (the current format). Lazily
 * initialised on first use so the cost is paid only when the V3
 * cache is actually hit, not on every tool invocation.
 */
let _root: protobuf.Root | null = null;

function _getRoot(): protobuf.Root {
	if (_root) return _root;
	// JSON mirror of `core/graph.proto`. Keep these two in sync --
	// the unit test `tests/cache-proto-schema.test.ts` asserts
	// that the parsed .proto and this JSON agree on field set,
	// IDs, and types.
	_root = protobuf.Root.fromJSON({
		nested: {
			shazam: {
				nested: {
					graph: {
						nested: {
							v3: {
								nested: {
									EdgeColumn: {
										fields: {
											// source / target are kept in the schema
											// for forward-compat with future wire-format
											// revisions. V3.1+ leaves them as empty
											// arrays and references IDs by int32 index
											// into the top-level `string_table` instead.
											source: { rule: "repeated", type: "string", id: 1 },
											target: { rule: "repeated", type: "string", id: 2 },
											weight: { rule: "repeated", type: "double", id: 3 },
											// V3.2 (issue #647): kind is int32. Mapping
											// 0=call, 1=type, 2=import, 3=ref,
											// 4=typeRef, 5=import-binding. Unknown
											// values decode as "call" via the helper
											// in core/cache.ts.
											kind: { rule: "repeated", type: "int32", id: 4 },
											confidence: { rule: "repeated", type: "double", id: 5 },
											provenance: { rule: "repeated", type: "int32", id: 6 },
										},
									},
									FileEdgeColumn: {
										fields: {
											file: { rule: "repeated", type: "string", id: 1 },
											symbol_id: { rule: "repeated", type: "string", id: 2 },
											count: { rule: "repeated", type: "int32", id: 3 },
											// V3.2 (issue #647): kind is int32. Same
											// mapping as EdgeColumn.kind.
											kind: { rule: "repeated", type: "int32", id: 4 },
										},
									},
									GraphPayload: {
										fields: {
											metadata: { type: "bytes", id: 1 },
											edges: { type: "EdgeColumn", id: 2 },
											file_edges: { type: "FileEdgeColumn", id: 3 },
											// V3.1 string table -- dedupes symbol IDs
											// that appear repeatedly across edges.
											string_table: { rule: "repeated", type: "string", id: 4 },
											edge_source_idx: { rule: "repeated", type: "int32", id: 5 },
											edge_target_idx: { rule: "repeated", type: "int32", id: 6 },
										},
									},
								},
							},
						},
					},
				},
			},
		},
	});
	return _root;
}

/** Reset the cached root. Test-only. */
export function _resetProtoSchemaCache(): void {
	_root = null;
}

/**
 * Typed message instances for the cache writer. Exposed so callers
 * can construct messages with full IDE type-checking instead of
 * relying on the loose `protobuf.Type` API.
 */
export interface ProtoEdgeColumn {
	source: string[];
	target: string[];
	weight: number[];
	// V3.2 (issue #647): kind is an int32 enum. See `_kindToInt` in
	// `core/cache.ts` for the mapping.
	kind: number[];
	confidence: number[];
	provenance: number[];
}

export interface ProtoFileEdgeColumn {
	file: string[];
	symbol_id: string[];
	count: number[];
	// V3.2 (issue #647): kind is an int32 enum.
	kind: number[];
}

export interface ProtoGraphPayload {
	metadata: Uint8Array;
	edges: ProtoEdgeColumn;
	file_edges: ProtoFileEdgeColumn;
	// V3.1 string table -- dedupes the `source` / `target` IDs
	// across every edge. Optional in the wire type because the
	// V3.0 schema (no string table) is still encodable; the cache
	// writer always populates both arrays together.
	string_table?: string[];
	edge_source_idx?: number[];
	edge_target_idx?: number[];
}

/**
 * Look up the EdgeColumn message type from the cached root.
 * Re-exposed for tests that need to construct messages directly.
 */
export function getEdgeColumnType(): protobuf.Type {
	return _getRoot().lookupType("shazam.graph.v3.EdgeColumn");
}

/** Look up the FileEdgeColumn message type. */
export function getFileEdgeColumnType(): protobuf.Type {
	return _getRoot().lookupType("shazam.graph.v3.FileEdgeColumn");
}

/** Look up the GraphPayload message type. */
export function getGraphPayloadType(): protobuf.Type {
	return _getRoot().lookupType("shazam.graph.v3.GraphPayload");
}

/**
 * Encode a GraphPayload message to a Buffer. Wraps the protobufjs
 * API in a typed helper so callers don't have to import protobufjs
 * themselves.
 */
export function encodeGraphPayload(payload: ProtoGraphPayload): Buffer {
	const Type = getGraphPayloadType();
	const err = Type.verify(payload);
	if (err) throw new Error(`GraphPayload verification failed: ${err}`);
	const message = Type.create(payload);
	return Buffer.from(Type.encode(message).finish());
}

/**
 * Decode a Buffer back to a GraphPayload. Throws on malformed input
 * (corrupted magic, truncated fields, unknown wire types).
 */
export function decodeGraphPayload(buffer: Buffer | Uint8Array): ProtoGraphPayload {
	const Type = getGraphPayloadType();
	const message = Type.decode(buffer);
	return Type.toObject(message, {
		defaults: true,
		arrays: true,
		// Default: bytes are returned as Buffer (Node-friendly) so
		// callers can pass them to TextDecoder without re-wrapping.
	}) as unknown as ProtoGraphPayload;
}

// -- V3.1 schema (legacy, for in-place upgrade) ----------------------------

/**
 * V3.1 ProtoBuf Root. Identical to the V3.2 Root except `kind` is
 * `repeated string` (not int32). This is the schema that real V3.1
 * buffers (written by the V3.1 release of pi-shazam) used. The
 * V3.1 reader in `core/cache.ts` decodes with this Root so the
 * `loadGraphCache` in-place converter can upgrade legacy caches
 * to V3.2 without forcing a re-scan.
 *
 * The V3.0 schema is the same as V3.1 (kind=string) for our
 * purposes -- the only V3.0-specific difference is that
 * `string_table` / `edge_source_idx` / `edge_target_idx` are
 * absent from the GraphPayload message. We reuse the V3.1 Root
 * for V3.0 decoding; the V3.0 reader in `core/cache.ts` simply
 * reads the inline `edges.source` / `edges.target` fields and
 * ignores the index columns.
 */
let _rootV31: protobuf.Root | null = null;

function _getRootV31(): protobuf.Root {
	if (_rootV31) return _rootV31;
	_rootV31 = protobuf.Root.fromJSON({
		nested: {
			shazam: {
				nested: {
					graph: {
						nested: {
							v3: {
								nested: {
									EdgeColumn: {
										fields: {
											source: { rule: "repeated", type: "string", id: 1 },
											target: { rule: "repeated", type: "string", id: 2 },
											weight: { rule: "repeated", type: "double", id: 3 },
											// V3.1 difference: kind is a string here.
											kind: { rule: "repeated", type: "string", id: 4 },
											confidence: { rule: "repeated", type: "double", id: 5 },
											provenance: { rule: "repeated", type: "int32", id: 6 },
										},
									},
									FileEdgeColumn: {
										fields: {
											file: { rule: "repeated", type: "string", id: 1 },
											symbol_id: { rule: "repeated", type: "string", id: 2 },
											count: { rule: "repeated", type: "int32", id: 3 },
											kind: { rule: "repeated", type: "string", id: 4 },
										},
									},
									GraphPayload: {
										fields: {
											metadata: { type: "bytes", id: 1 },
											edges: { type: "EdgeColumn", id: 2 },
											file_edges: { type: "FileEdgeColumn", id: 3 },
											string_table: { rule: "repeated", type: "string", id: 4 },
											edge_source_idx: { rule: "repeated", type: "int32", id: 5 },
											edge_target_idx: { rule: "repeated", type: "int32", id: 6 },
										},
									},
								},
							},
						},
					},
				},
			},
		},
	});
	return _rootV31;
}

/** V3.1-specific GraphPayload type. */
export function getGraphPayloadTypeV31(): protobuf.Type {
	return _getRootV31().lookupType("shazam.graph.v3.GraphPayload");
}

/**
 * V3.1-specific decoder. Reads a V3.1 buffer (kind as string) and
 * returns a `ProtoGraphPayloadV31` whose `kind` columns are
 * `string[]`. The V3.1 reader in `core/cache.ts` converts each
 * string to an int (via `_kindToInt`) before feeding it into the
 * same edge-rebuild path as the V3.2 reader.
 */
export interface ProtoGraphPayloadV31 {
	metadata: Uint8Array;
	edges: {
		source: string[];
		target: string[];
		weight: number[];
		kind: string[];
		confidence: number[];
		provenance: number[];
	};
	file_edges: {
		file: string[];
		symbol_id: string[];
		count: number[];
		kind: string[];
	};
	string_table: string[];
	edge_source_idx: number[];
	edge_target_idx: number[];
}

export function decodeGraphPayloadV31(buffer: Buffer | Uint8Array): ProtoGraphPayloadV31 {
	const Type = getGraphPayloadTypeV31();
	const message = Type.decode(buffer);
	return Type.toObject(message, {
		defaults: true,
		arrays: true,
	}) as unknown as ProtoGraphPayloadV31;
}

/**
 * V3.1-specific encoder. Encodes a V3.1 `GraphPayload` (kind as
 * string) to a Buffer. Used by tests to construct true V3.1
 * buffers for round-trip verification of `deserializeGraphV3V1`.
 * The on-disk V3.1 cache writer was the previous release of
 * pi-shazam (the just-shipped #647 first-pass), so this encoder
 * is only called by tests and the `loadGraphCache` in-place
 * converter's regression coverage.
 */
export function encodeGraphPayloadV31(payload: ProtoGraphPayloadV31): Buffer {
	const Type = getGraphPayloadTypeV31();
	const err = Type.verify(payload);
	if (err) throw new Error(`V3.1 GraphPayload verification failed: ${err}`);
	const message = Type.create(payload);
	return Buffer.from(Type.encode(message).finish());
}

/** Reset the V3.1 root cache. Test-only. */
export function _resetProtoSchemaV31Cache(): void {
	_rootV31 = null;
}

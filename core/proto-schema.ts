/**
 * pi-shazam core/proto-schema -- ProtoBuf schema for the V3 graph cache.
 *
 * Issue #628: compact columnar ProtoBuf encoding for the on-disk
 * graph cache. The V2 JSON format is dense and produces ~800KB files
 * for a 1000-symbol project; this module gives the V3 cache a binary
 * wire format that compresses the same edge data by 50-70%.
 *
 * The runtime uses the `protobufjs` library with a JSON schema
 * defined inline (mirroring `core/graph.proto`). Defining the schema
 * as JSON in code avoids a build step + ~70KB of generated static
 * module that would otherwise ship in `dist/`. The `core/graph.proto`
 * file remains the canonical source of truth for the schema and is
 * what external tools (e.g. language bindings) should consume.
 *
 * The schema is intentionally narrow: only the edge maps
 * (incoming / outgoing / fileCalls / fileRefs / fileTypeRefs)
 * are encoded in ProtoBuf. Symbols and fileSymbols stay in JSON
 * (stored as the `metadata` bytes field) because they are few and
 * their per-string overhead would dominate the binary encoding.
 */
import protobuf from "protobufjs";

/**
 * ProtoBuf root namespace. Lazily initialised on first use so
 * the cost is paid only when the V3 cache is actually hit, not
 * on every tool invocation.
 */
let _root: protobuf.Root | null = null;

function _getRoot(): protobuf.Root {
	if (_root) return _root;
	// JSON mirror of `core/graph.proto`. Keep these two in sync --
	// the unit test `tests/cache-proto-schema.test.ts` asserts
	// that a sample message round-trips through the live types.
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
											source: { rule: "repeated", type: "string", id: 1 },
											target: { rule: "repeated", type: "string", id: 2 },
											weight: { rule: "repeated", type: "double", id: 3 },
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
	kind: string[];
	confidence: number[];
	provenance: number[];
}

export interface ProtoFileEdgeColumn {
	file: string[];
	symbol_id: string[];
	count: number[];
	kind: string[];
}

export interface ProtoGraphPayload {
	metadata: Uint8Array;
	edges: ProtoEdgeColumn;
	file_edges: ProtoFileEdgeColumn;
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

/**
 * pi-shazam core/graph — Symbol dependency graph data model.
 *
 * Ported from repomap/src/__init__.py (Symbol, Edge, RepoGraph dataclasses).
 * All other core/ modules depend on these types.
 */

// ── Core data types ──────────────────────────────────────────────────────────

/** A code symbol (function, class, interface, etc.) */
export interface Symbol {
	id: string;
	name: string;
	kind: string;
	file: string;
	line: number;
	endLine: number;
	col: number;
	visibility: "public" | "private" | "exported";
	docstring: string;
	signature: string;
	returnType: string;
	params: string;
	pagerank: number;
}

/** A directed edge in the dependency graph */
export interface Edge {
	source: string;
	target: string;
	weight: number;
	kind: string;
	confidence: number;
}

/** Full symbol dependency graph */
export interface RepoGraph {
	symbols: Map<string, Symbol>;
	outgoing: Map<string, Edge[]>;
	incoming: Map<string, Edge[]>;
	fileSymbols: Map<string, string[]>;
	fileImports: Map<string, string[]>;
	fileCalls: Map<string, [string, number, string][]>;
	fileImportBindings: Map<string, JSImportBinding[]>;
	fileExports: Map<string, JSExportBinding[]>;
}

/** A JS/TS import binding */
export interface JSImportBinding {
	localName: string;
	importedName: string;
	module: string;
	line: number;
	kind: "default" | "named" | "namespace";
}

/** A JS/TS export binding */
export interface JSExportBinding {
	exportedName: string;
	sourceName: string | null;
	module: string | null;
	line: number;
	kind: "local" | "reexport" | "namespace" | "wildcard";
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createRepoGraph(): RepoGraph {
	return {
		symbols: new Map(),
		outgoing: new Map(),
		incoming: new Map(),
		fileSymbols: new Map(),
		fileImports: new Map(),
		fileCalls: new Map(),
		fileImportBindings: new Map(),
		fileExports: new Map(),
	};
}

// ── Symbol factory ───────────────────────────────────────────────────────────

export function createSymbol(
	id: string,
	name: string,
	kind: string,
	file: string,
	line: number,
	overrides: Partial<Symbol> = {},
): Symbol {
	return {
		id,
		name,
		kind,
		file,
		line,
		endLine: overrides.endLine ?? line,
		col: overrides.col ?? 0,
		visibility: overrides.visibility ?? "public",
		docstring: overrides.docstring ?? "",
		signature: overrides.signature ?? "",
		returnType: overrides.returnType ?? "",
		params: overrides.params ?? "",
		pagerank: overrides.pagerank ?? 0.0,
	};
}

// ── Edge factory ─────────────────────────────────────────────────────────────

export function createEdge(
	source: string,
	target: string,
	weight: number,
	kind: string,
	confidence: number = 1.0,
): Edge {
	return { source, target, weight, kind, confidence };
}

// ── Serialization (for cache) ────────────────────────────────────────────────

export interface SerializedSymbol {
	id: string;
	name: string;
	kind: string;
	file: string;
	line: number;
	endLine: number;
	col: number;
	visibility: string;
	signature: string;
	returnType: string;
	params: string;
	docstring: string;
	pagerank: number;
}

export interface SerializedEdge {
	source: string;
	target: string;
	weight: number;
	kind: string;
}

export interface SerializedGraph {
	symbols: SerializedSymbol[];
	edges: SerializedEdge[];
	version: number;
	timestamp: number;
}

export function serializeSymbol(sym: Symbol): SerializedSymbol {
	return {
		id: sym.id,
		name: sym.name,
		kind: sym.kind,
		file: sym.file,
		line: sym.line,
		endLine: sym.endLine,
		col: sym.col,
		visibility: sym.visibility,
		signature: sym.signature,
		returnType: sym.returnType,
		params: sym.params,
		docstring: sym.docstring,
		pagerank: sym.pagerank,
	};
}

export function serializeEdge(edge: Edge): SerializedEdge {
	return {
		source: edge.source,
		target: edge.target,
		weight: edge.weight,
		kind: edge.kind,
	};
}

export function serializeGraph(graph: RepoGraph): SerializedGraph {
	const symbols: SerializedSymbol[] = [];
	for (const sym of graph.symbols.values()) {
		symbols.push(serializeSymbol(sym));
	}
	const edges: SerializedEdge[] = [];
	for (const [, edgeList] of graph.outgoing) {
		for (const edge of edgeList) {
			edges.push(serializeEdge(edge));
		}
	}
	return {
		symbols,
		edges,
		version: 1,
		timestamp: Date.now(),
	};
}

// ── Graph snapshot comparison ────────────────────────────────────────────────

export interface GraphDiff {
	summary: {
		added: number;
		removed: number;
		modified: number;
		edgesAdded: number;
		edgesRemoved: number;
	};
	addedSymbols: { id: string; name: string; file: string; line: number }[];
	removedSymbols: { id: string; name: string; file: string; line: number }[];
	modifiedSymbols: ModifiedSymbol[];
	callChainChanges: {
		newCalls: { from: string; to: string; kind: string }[];
		removedCalls: { from: string; to: string; kind: string }[];
	};
}

export interface ModifiedSymbol {
	id: string;
	name: string;
	file: string;
	visibility: string;
	kind: string;
	lineChange: string;
	oldSignature: string;
	newSignature: string;
	signatureChanged: boolean;
	affectedCallers?: { symbolId: string; kind: string }[];
	affectedCallerCount?: number;
	risk?: "HIGH" | "MEDIUM" | "LOW";
}

function edgeIdentity(edge: Edge): string {
	return `${edge.source}|${edge.target}|${edge.kind}`;
}

function edgeIdentityFromRow(row: SerializedEdge): string {
	return `${row.source}|${row.target}|${row.kind}`;
}

function stableKey(sym: { file: string; name: string; kind: string }): string {
	return `${sym.file}::${sym.name}::${sym.kind}`;
}

export function compareGraphSnapshots(
	currentSymbols: Symbol[],
	currentEdges: Edge[],
	previousSymbols: SerializedSymbol[],
	previousEdges: SerializedEdge[],
): GraphDiff {
	const currentSymMap = new Map(currentSymbols.map((s) => [s.id, s]));
	const prevSymMap = new Map(previousSymbols.map((s) => [s.id, s]));

	const currentIds = new Set(currentSymMap.keys());
	const prevIds = new Set(prevSymMap.keys());

	let addedIds = [...currentIds].filter((id) => !prevIds.has(id));
	let removedIds = [...prevIds].filter((id) => !currentIds.has(id));

	// Stable key matching for line-drift reconciliation
	const addedByKey = new Map<string, string[]>();
	for (const sid of addedIds) {
		const s = currentSymMap.get(sid)!;
		const key = stableKey(s);
		const arr = addedByKey.get(key) || [];
		arr.push(sid);
		addedByKey.set(key, arr);
	}
	const removedByKey = new Map<string, string[]>();
	for (const sid of removedIds) {
		const s = prevSymMap.get(sid)!;
		const key = stableKey(s);
		const arr = removedByKey.get(key) || [];
		arr.push(sid);
		removedByKey.set(key, arr);
	}

	const reconciledPairs: [string, string][] = [];
	for (const [key, adds] of addedByKey) {
		const rems = removedByKey.get(key) || [];
		for (let i = 0; i < Math.min(adds.length, rems.length); i++) {
			reconciledPairs.push([rems[i], adds[i]]);
		}
	}
	const reconciledAdded = new Set(reconciledPairs.map((p) => p[1]));
	const reconciledRemoved = new Set(reconciledPairs.map((p) => p[0]));
	addedIds = addedIds.filter((id) => !reconciledAdded.has(id));
	removedIds = removedIds.filter((id) => !reconciledRemoved.has(id));

	// Modified: same ID, signature or location changed
	const commonIds = [...currentIds].filter((id) => prevIds.has(id));
	const modifiedSymbols: ModifiedSymbol[] = [];
	for (const id of commonIds) {
		const cur = currentSymMap.get(id)!;
		const prev = prevSymMap.get(id)!;
		const sigChanged = cur.signature !== prev.signature;
		const locChanged =
			cur.line !== prev.line ||
			cur.endLine !== prev.endLine ||
			cur.file !== prev.file;
		if (sigChanged || locChanged) {
			modifiedSymbols.push({
				id: cur.id,
				name: cur.name,
				file: cur.file,
				visibility: cur.visibility,
				kind: cur.kind,
				lineChange: `${prev.line} -> ${cur.line}`,
				oldSignature: prev.signature,
				newSignature: cur.signature,
				signatureChanged: sigChanged,
				risk: sigChanged ? "HIGH" : "LOW",
			});
		}
	}

	// Reconciled pairs as modified
	for (const [prevId, curId] of reconciledPairs) {
		const cur = currentSymMap.get(curId)!;
		const prev = prevSymMap.get(prevId)!;
		const sigChanged = cur.signature !== prev.signature;
		modifiedSymbols.push({
			id: cur.id,
			name: cur.name,
			file: cur.file,
			visibility: cur.visibility,
			kind: cur.kind,
			lineChange: `${prev.line} -> ${cur.line}`,
			oldSignature: prev.signature,
			newSignature: cur.signature,
			signatureChanged: sigChanged,
			risk: sigChanged ? "HIGH" : "LOW",
		});
	}

	// Edge changes
	const currentEdgeSet = new Set(currentEdges.map(edgeIdentity));
	const prevEdgeSet = new Set(previousEdges.map(edgeIdentityFromRow));

	const edgesAdded = [...currentEdgeSet].filter((e) => !prevEdgeSet.has(e));
	const edgesRemoved = [...prevEdgeSet].filter((e) => !currentEdgeSet.has(e));

	return {
		summary: {
			added: addedIds.length,
			removed: removedIds.length,
			modified: modifiedSymbols.length,
			edgesAdded: edgesAdded.length,
			edgesRemoved: edgesRemoved.length,
		},
		addedSymbols: addedIds.map((id) => {
			const s = currentSymMap.get(id)!;
			return { id: s.id, name: s.name, file: s.file, line: s.line };
		}),
		removedSymbols: removedIds.map((id) => {
			const s = prevSymMap.get(id)!;
			return { id: s.id, name: s.name, file: s.file, line: s.line };
		}),
		modifiedSymbols,
		callChainChanges: {
			newCalls: edgesAdded.slice(0, 20).map((e) => {
				const [from, to, kind] = e.split("|");
				return { from, to, kind };
			}),
			removedCalls: edgesRemoved.slice(0, 20).map((e) => {
				const [from, to, kind] = e.split("|");
				return { from, to, kind };
			}),
		},
	};
}

// ── Constants ────────────────────────────────────────────────────────────────

export const LOW_SIGNAL_KINDS = new Set([
	"element",
	"selector",
	"class_selector",
	"id_selector",
	"json_key",
]);

export const BOILERPLATE_NAMES = new Set(["__init__", "__main__"]);

export function signalWeightForSymbol(
	kind: string,
	name: string,
	visibility: string,
): number {
	if (LOW_SIGNAL_KINDS.has(kind)) return 0.002;
	if (BOILERPLATE_NAMES.has(name)) return 0.35;
	if (name.startsWith("_") && visibility === "private") return 0.85;
	return 1.0;
}

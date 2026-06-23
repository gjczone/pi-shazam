/**
 * pi-shazam core/graph -- Symbol dependency graph data model.
 *
 * Ported from repomap/src/__init__.py (Symbol, Edge, RepoGraph dataclasses).
 * All other core/ modules depend on these types.
 */

// -- Core data types ----------------------------------------------------------

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
	fileRefs: Map<string, [string, number][]>;
	fileImportBindings: Map<string, JSImportBinding[]>;
	/** Index symbols by name for O(1) lookup in findCalleeSymbols / findSymbolByNameInFile */
	nameIndex: Map<string, Symbol[]>;
	/** Reverse edge index: target symbol ID -> set of source symbol IDs pointing to it, speeds up cross-file edge cleanup in removeEdgesForFile */
	targetToSources: Map<string, Set<string>>;
}

/** A JS/TS import binding */
export interface JSImportBinding {
	localName: string;
	importedName: string;
	module: string;
	line: number;
	kind: "default" | "named" | "namespace";
}

// -- Edge counting ------------------------------------------------------------

/** Count total edges in the graph (sum of outgoing edge list lengths). */
export function getGraphEdgeCount(graph: RepoGraph): number {
	let count = 0;
	for (const [, edges] of graph.outgoing) {
		count += edges.length;
	}
	return count;
}

// -- Factory ------------------------------------------------------------------

const VALID_VISIBILITY = new Set(["public", "private", "exported"]);

export function createRepoGraph(): RepoGraph {
	return {
		symbols: new Map(),
		outgoing: new Map(),
		incoming: new Map(),
		fileSymbols: new Map(),
		fileImports: new Map(),
		fileCalls: new Map(),
		fileRefs: new Map(),
		fileImportBindings: new Map(),
		nameIndex: new Map(),
		targetToSources: new Map(),
	};
}

// -- Symbol factory -----------------------------------------------------------

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

// -- Edge factory -------------------------------------------------------------

export function createEdge(
	source: string,
	target: string,
	weight: number,
	kind: string,
	confidence: number = 1.0,
): Edge {
	return { source, target, weight, kind, confidence };
}

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
	confidence?: number;
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
		confidence: edge.confidence,
	};
}

export interface SerializedGraphV2 {
	version: 2;
	timestamp: number;
	symbols: SerializedSymbol[];
	edges: SerializedEdge[];
	fileSymbols: Record<string, string[]>;
	fileImports: Record<string, [string, number][]>;
	fileRefs: Record<string, [string, number][]>;
	fileCalls: Record<string, [string, number, string][]>;
	fileImportBindings: Record<string, JSImportBinding[]>;
	fileMtimes: Record<string, number>;
}

export function serializeGraphV2(graph: RepoGraph, fileMtimes: Map<string, number>): SerializedGraphV2 {
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

	const fileSymbols: Record<string, string[]> = {};
	for (const [k, v] of graph.fileSymbols) fileSymbols[k] = v;

	const fileImports: Record<string, [string, number][]> = {};
	for (const [k, v] of graph.fileImports) fileImports[k] = v.map((m) => [m, 0]);

	const fileCalls: Record<string, [string, number, string][]> = {};
	for (const [k, v] of graph.fileCalls) fileCalls[k] = v;

	const fileRefs: Record<string, [string, number][]> = {};
	for (const [k, v] of graph.fileRefs) fileRefs[k] = v;

	const fileImportBindings: Record<string, JSImportBinding[]> = {};
	for (const [k, v] of graph.fileImportBindings) fileImportBindings[k] = v;

	const fileMtimesObj: Record<string, number> = {};
	for (const [k, v] of fileMtimes) fileMtimesObj[k] = v;

	return {
		version: 2,
		timestamp: Date.now(),
		symbols,
		edges,
		fileSymbols,
		fileImports,
		fileRefs,
		fileCalls,
		fileImportBindings,
		fileMtimes: fileMtimesObj,
	};
}

export function deserializeGraphV2(data: SerializedGraphV2): RepoGraph {
	const graph = createRepoGraph();

	for (const s of data.symbols) {
		const sym: Symbol = {
			id: s.id,
			name: s.name,
			kind: s.kind,
			file: s.file,
			line: s.line,
			endLine: s.endLine,
			col: s.col,
			visibility: VALID_VISIBILITY.has(s.visibility) ? (s.visibility as "public" | "private" | "exported") : "public",
			docstring: s.docstring,
			signature: s.signature,
			returnType: s.returnType,
			params: s.params,
			pagerank: s.pagerank,
		};
		graph.symbols.set(s.id, sym);
		// Rebuild nameIndex
		const named = graph.nameIndex.get(sym.name);
		if (named) {
			named.push(sym);
		} else {
			graph.nameIndex.set(sym.name, [sym]);
		}
	}

	for (const e of data.edges) {
		// H6: Skip edges with dangling source/target (corrupted or version-mismatched cache)
		if (!graph.symbols.has(e.source) || !graph.symbols.has(e.target)) {
			console.warn(`[pi-shazam] deserializeGraphV2: skipping dangling edge ${e.source} -> ${e.target}`);
			continue;
		}
		const edge: Edge = {
			source: e.source,
			target: e.target,
			weight: e.weight,
			kind: e.kind,
			confidence: e.confidence ?? 1.0,
		};
		const outgoing = graph.outgoing.get(e.source) || [];
		outgoing.push(edge);
		graph.outgoing.set(e.source, outgoing);

		const incoming = graph.incoming.get(e.target) || [];
		incoming.push(edge);
		graph.incoming.set(e.target, incoming);

		// Rebuild targetToSources index
		const sources = graph.targetToSources.get(e.target);
		if (sources) {
			sources.add(e.source);
		} else {
			graph.targetToSources.set(e.target, new Set([e.source]));
		}
	}

	for (const [k, v] of Object.entries(data.fileSymbols)) {
		graph.fileSymbols.set(k, v);
	}
	for (const [k, v] of Object.entries(data.fileImports)) {
		// M4: fileImports serialized as [string, number][] to preserve line numbers
		const imports = Array.isArray(v) && v.length > 0 && Array.isArray(v[0])
			? (v as [string, number][]).map(([m]) => m)
			: (v as unknown as string[]);
		graph.fileImports.set(k, imports);
	}
	for (const [k, v] of Object.entries(data.fileCalls)) {
		graph.fileCalls.set(k, v);
	}
	for (const [k, v] of Object.entries(data.fileRefs ?? {})) {
		graph.fileRefs.set(k, v);
	}
	for (const [k, v] of Object.entries(data.fileImportBindings)) {
		graph.fileImportBindings.set(k, v);
	}
	return graph;
}

// -- Graph snapshot comparison ------------------------------------------------

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
	// M5: Include weight and confidence in edge identity so that
	// compareGraphSnapshots detects modified edges, not just added/removed ones.
	return `${edge.source}::${edge.target}::${edge.kind}::${edge.weight}::${edge.confidence}`;
}

function edgeIdentityFromRow(row: SerializedEdge): string {
	return `${row.source}::${row.target}::${row.kind}::${row.weight}::${row.confidence ?? 1.0}`;
}

function stableKey(sym: { file: string; name: string; kind: string }): string {
	return `${sym.file}::${sym.name}::${sym.kind}`;
}

/** Cache data loaded from disk, re-exported by core/cache.ts. */
export interface GraphCacheData {
	graph: RepoGraph;
	fileMtimes: Map<string, number>;
	timestamp: number;
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
		const locChanged = cur.line !== prev.line || cur.endLine !== prev.endLine || cur.file !== prev.file;
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
				const [from, to, kind] = e.split("::", 3);
				return { from: from!, to: to!, kind: kind! };
			}),
			removedCalls: edgesRemoved.slice(0, 20).map((e) => {
				const [from, to, kind] = e.split("::", 3);
				return { from: from!, to: to!, kind: kind! };
			}),
		},
	};
}

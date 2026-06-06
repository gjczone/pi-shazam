/**
 * pi-shazam tools/call_chain — Call graph traversal.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool } from "./_factory.js";

export function registerCallChain(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_call_chain",
		label: "Call Chain Analysis",
		description: `\
		Without this, you ship bugs. Every caller you miss when changing a
		function signature is a runtime error. Traces ALL upstream callers,
		downstream callees, and references for any symbol. Pass --depth to
		control traversal depth (default 2). Pass --flat for a simple flat
		list of all references.`,
		params: Type.Object({
			symbol: Type.String(),
			depth: Type.Optional(Type.Number()),
			flat: Type.Optional(Type.Boolean()),
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			const flat = (params.flat as boolean) ?? false;
			const depth = (params.depth as number) ?? 2;
			const symbolName = params.symbol as string;
			if (flat) {
				const refs = getFlatReferences(graph, symbolName);
				return json ? JSON.stringify(refs, null, 2) : formatFlatReferences(refs, symbolName);
			}
			return json
				? executeCallChainJson(graph, symbolName, depth)
				: executeCallChain(graph, symbolName, depth);
		},
	});
}

export function executeCallChain(
	graph: RepoGraph,
	symbolName: string,
	depth: number = 2,
): string {
	const targets = findSymbolsByName(graph, symbolName);
	if (targets.length === 0) {
		return `Symbol not found: ${symbolName}`;
	}

	const lines: string[] = [];
	for (const target of targets) {
		lines.push(
			`## Call Chain for ${target.kind} \`${target.name}\` (${target.file}:${target.line})`,
		);
		lines.push("");

		// Incoming callers (upstream) — BFS
		const incomingChain = traceIncoming(graph, target.id, depth);
		if (incomingChain.length > 0) {
			lines.push(`### Incoming Calls (${incomingChain.length} callers in ${depth} levels)`);
			for (const [level, sym, edge] of incomingChain) {
				const indent = "  ".repeat(level);
				lines.push(
					`${indent}L${level}: ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (${edge.kind})`,
				);
			}
		}

		// Outgoing callees (downstream) — BFS
		const outgoingChain = traceOutgoing(graph, target.id, depth);
		if (outgoingChain.length > 0) {
			lines.push("");
			lines.push(`### Outgoing Calls (${outgoingChain.length} callees in ${depth} levels)`);
			for (const [level, sym, edge] of outgoingChain) {
				const indent = "  ".repeat(level);
				lines.push(
					`${indent}L${level}: ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (${edge.kind})`,
				);
			}
		}

		lines.push("");
	}

	// Add Next recommendations
	const nextItems = getNextForTool("call_chain", { topSymbol: targets[0]?.name });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n").trim();
}

export function executeCallChainJson(
	graph: RepoGraph,
	symbolName: string,
	depth: number,
): string {
	const targets = findSymbolsByName(graph, symbolName);
	const result = targets.map((target) => ({
		symbol: { id: target.id, name: target.name, kind: target.kind, file: target.file, line: target.line },
		incoming: traceIncoming(graph, target.id, depth).map(([level, sym, edge]) => ({
			level,
			symbol: sym.name,
			file: sym.file,
			kind: edge.kind,
		})),
		outgoing: traceOutgoing(graph, target.id, depth).map(([level, sym, edge]) => ({
			level,
			symbol: sym.name,
			file: sym.file,
			kind: edge.kind,
		})),
	}));

	return JSON.stringify({
		schema_version: "1.0",
		command: "call_chain",
		status: "ok",
		result,
	});
}

function findSymbolsByName(graph: RepoGraph, name: string): Symbol[] {
	const results: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === name) results.push(sym);
	}
	return results;
}

function traceIncoming(
	graph: RepoGraph,
	startId: string,
	maxDepth: number,
): [number, Symbol, { kind: string }][] {
	const visited = new Set<string>();
	const result: [number, Symbol, { kind: string }][] = [];
	const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
	visited.add(startId);

	while (queue.length > 0) {
		const { id, depth } = queue.shift()!;
		if (depth >= maxDepth) continue;

		const incoming = graph.incoming.get(id);
		if (!incoming) continue;

		for (const edge of incoming) {
			const srcSym = graph.symbols.get(edge.source);
			if (!srcSym || visited.has(edge.source)) continue;
			visited.add(edge.source);
			result.push([depth + 1, srcSym, edge]);
			queue.push({ id: edge.source, depth: depth + 1 });
		}
	}

	return result;
}

function traceOutgoing(
	graph: RepoGraph,
	startId: string,
	maxDepth: number,
): [number, Symbol, { kind: string }][] {
	const visited = new Set<string>();
	const result: [number, Symbol, { kind: string }][] = [];
	const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
	visited.add(startId);

	while (queue.length > 0) {
		const { id, depth } = queue.shift()!;
		if (depth >= maxDepth) continue;

		const outgoing = graph.outgoing.get(id);
		if (!outgoing) continue;

		for (const edge of outgoing) {
			const tgtSym = graph.symbols.get(edge.target);
			if (!tgtSym || visited.has(edge.target)) continue;
			visited.add(edge.target);
			result.push([depth + 1, tgtSym, edge]);
			queue.push({ id: edge.target, depth: depth + 1 });
		}
	}

	return result;
}

// ── --flat mode (replaces shazam_refs) ────────────────────────────────────────

interface FlatReference {
	symbol: string;
	file: string;
	line: number;
	kind: string;
	direction: string;
}

export function getFlatReferences(
	graph: RepoGraph,
	symbolName: string,
): FlatReference[] {
	const targets = findSymbolsByName(graph, symbolName);
	if (targets.length === 0) return [];

	const refs: FlatReference[] = [];
	const seen = new Set<string>();

	for (const target of targets) {
		// Incoming references (who calls this symbol)
		const incoming = graph.incoming.get(target.id);
		if (incoming) {
			for (const edge of incoming) {
				const src = graph.symbols.get(edge.source);
				if (!src) continue;
				const key = `${src.name}:${src.file}:${src.line}`;
				if (seen.has(key)) continue;
				seen.add(key);
				refs.push({
					symbol: src.name,
					file: src.file,
					line: src.line,
					kind: src.kind,
					direction: "incoming",
				});
			}
		}

		// Outgoing references (what this symbol calls)
		const outgoing = graph.outgoing.get(target.id);
		if (outgoing) {
			for (const edge of outgoing) {
				const tgt = graph.symbols.get(edge.target);
				if (!tgt) continue;
				const key = `${tgt.name}:${tgt.file}:${tgt.line}`;
				if (seen.has(key)) continue;
				seen.add(key);
				refs.push({
					symbol: tgt.name,
					file: tgt.file,
					line: tgt.line,
					kind: tgt.kind,
					direction: "outgoing",
				});
			}
		}
	}

	return refs;
}

export function formatFlatReferences(
	refs: FlatReference[],
	symbolName: string,
): string {
	if (refs.length === 0) {
		return `No references found for "${symbolName}".`;
	}

	const lines: string[] = [
		`## Flat References for \`${symbolName}\` (${refs.length} total)`,
		"",
	];

	const incoming = refs.filter((r) => r.direction === "incoming");
	const outgoing = refs.filter((r) => r.direction === "outgoing");

	if (incoming.length > 0) {
		lines.push(`### Incoming (${incoming.length})`);
		for (const r of incoming) {
			lines.push(
				`- ${r.kind} \`${r.symbol}\` — ${r.file}:${r.line}`,
			);
		}
		lines.push("");
	}

	if (outgoing.length > 0) {
		lines.push(`### Outgoing (${outgoing.length})`);
		for (const r of outgoing) {
			lines.push(
				`- ${r.kind} \`${r.symbol}\` — ${r.file}:${r.line}`,
			);
		}
		lines.push("");
	}

	// Add Next recommendations
	const nextItems = getNextForTool("call_chain");
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}


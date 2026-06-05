/**
 * pi-shazam tools/call_chain — Call graph traversal.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerCallChain(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_call_chain",
		label: "Call Chain Analysis",
		description: `\
MUST call before changing a function signature, deleting code, or
refactoring. Traces ALL upstream callers and downstream callees for a
symbol. Without this, you cannot know the blast radius. Every caller
you miss is a bug you will ship.

Returns: incoming calls (who calls this), outgoing calls (what this
calls), and full reference list. Pass --depth to control traversal
depth (default 2).

Scenario: changing parameter order. Removing a function. Renaming an
exported symbol. Changing return type. Adding required parameters.`,
		parameters: pi.typebox.Object({
			symbol: pi.typebox.String(),
			depth: pi.typebox.Optional(pi.typebox.Number()),
			json: pi.typebox.Optional(pi.typebox.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const depth = params.depth ?? 2;
			const result = executeCallChain(graph, params.symbol, depth);
			return {
				content: [
					{
						type: "text",
						text: json
							? executeCallChainJson(graph, params.symbol, depth)
							: result,
					},
				],
			};
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

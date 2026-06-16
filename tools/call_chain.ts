/**
 * pi-shazam tools/call_chain — Call graph traversal.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool } from "./_factory.js";
import { buildEnvelope } from "./_factory.js";
import { recordCallChain } from "../hooks/rename-state.js";

export function registerCallChain(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_call_chain",
		label: "Call Chain Analysis",
		description: `\
		Without this, you ship bugs. Every caller you miss when changing a
		function signature is a runtime error. Traces ALL upstream callers,
		downstream callees, and references for any symbol. Pass --depth to
		control traversal depth (default 2). Pass --flat for a simple flat
		list of all references. Pass --direction to filter by
		incoming/outgoing/both (default both).`,
		params: Type.Object({
			symbol: Type.String(),
			depth: Type.Optional(Type.Number()),
			flat: Type.Optional(Type.Boolean()),
			direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")])),
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			const flat = (params.flat as boolean) ?? false;
			const depth = (params.depth as number) ?? 2;
			const direction = (params.direction as string) ?? "both";
			const symbolName = typeof params.symbol === "string" ? params.symbol : "";
			if (!symbolName) return "Error: symbol parameter is required";
			// Mark this symbol as reviewed for the rename safety gate (issue #326)
			recordCallChain(symbolName);
			if (flat) {
				const refs = getFlatReferences(graph, symbolName, direction as "incoming" | "outgoing" | "both");
				return json ? JSON.stringify(refs, null, 2) : formatFlatReferences(refs, symbolName);
			}
			return json
				? executeCallChainJson(graph, symbolName, depth, direction as "incoming" | "outgoing" | "both")
				: executeCallChain(graph, symbolName, depth, direction as "incoming" | "outgoing" | "both");
		},
	});
}

/** Maximum number of refs to display per direction before truncating. */
const MAX_DISPLAY_REFS = 50;

export function executeCallChain(
	graph: RepoGraph,
	symbolName: string,
	depth: number = 2,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	const targets = findSymbolsByName(graph, symbolName);
	if (targets.length === 0) {
		return `Symbol not found: ${symbolName}`;
	}

	// Mark this symbol as reviewed for the rename safety gate (issue #326)
	recordCallChain(symbolName);

	const lines: string[] = [];
	for (const target of targets) {
		lines.push(`## Call Chain for ${target.kind} \`${target.name}\` (${target.file}:${target.line})`);
		lines.push("");

		// Incoming callers (upstream) — BFS
		if (direction !== "outgoing") {
			const incomingChain = traceIncoming(graph, target.id, depth);
			if (incomingChain.length > 0) {
				const shown = incomingChain.slice(0, MAX_DISPLAY_REFS);
				lines.push(`### Incoming Calls (${incomingChain.length} callers in ${depth} levels)`);
				for (const [level, sym, edge] of shown) {
					const indent = "  ".repeat(level);
					lines.push(`${indent}L${level}: ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (${edge.kind})`);
				}
				if (incomingChain.length > MAX_DISPLAY_REFS) {
					lines.push(`  ... and ${incomingChain.length - MAX_DISPLAY_REFS} more (use --maxTokens to see full output)`);
				}
			}
		}

		// Outgoing callees (downstream) — BFS
		if (direction !== "incoming") {
			const outgoingChain = traceOutgoing(graph, target.id, depth);
			if (outgoingChain.length > 0) {
				const shown = outgoingChain.slice(0, MAX_DISPLAY_REFS);
				lines.push("");
				lines.push(`### Outgoing Calls (${outgoingChain.length} callees in ${depth} levels)`);
				for (const [level, sym, edge] of shown) {
					const indent = "  ".repeat(level);
					lines.push(`${indent}L${level}: ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (${edge.kind})`);
				}
				if (outgoingChain.length > MAX_DISPLAY_REFS) {
					lines.push(`  ... and ${outgoingChain.length - MAX_DISPLAY_REFS} more (use --maxTokens to see full output)`);
				}
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
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	const targets = findSymbolsByName(graph, symbolName);
	// Mark this symbol as reviewed for the rename safety gate (issue #326)
	if (targets.length > 0) {
		recordCallChain(symbolName);
	}
	const result = targets.map((target) => ({
		symbol: { id: target.id, name: target.name, kind: target.kind, file: target.file, line: target.line },
		incoming:
			direction !== "outgoing"
				? traceIncoming(graph, target.id, depth).map(([level, sym, edge]) => ({
						level,
						symbol: sym.name,
						file: sym.file,
						kind: edge.kind,
					}))
				: [],
		outgoing:
			direction !== "incoming"
				? traceOutgoing(graph, target.id, depth).map(([level, sym, edge]) => ({
						level,
						symbol: sym.name,
						file: sym.file,
						kind: edge.kind,
					}))
				: [],
	}));

	return buildEnvelope("shazam_call_chain", process.cwd(), "ok", result);
}

function findSymbolsByName(graph: RepoGraph, name: string): Symbol[] {
	// Use nameIndex for O(1) lookup, avoid traversing all symbols
	return graph.nameIndex.get(name) ?? [];
}

function traceIncoming(graph: RepoGraph, startId: string, maxDepth: number): [number, Symbol, { kind: string }][] {
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

function traceOutgoing(graph: RepoGraph, startId: string, maxDepth: number): [number, Symbol, { kind: string }][] {
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
	direction: "incoming" | "outgoing" | "both" = "both",
): FlatReference[] {
	const targets = findSymbolsByName(graph, symbolName);
	if (targets.length === 0) return [];

	const refs: FlatReference[] = [];
	const seen = new Set<string>();

	for (const target of targets) {
		// Incoming references (who calls this symbol)
		if (direction !== "outgoing") {
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
		}

		// Outgoing references (what this symbol calls)
		if (direction !== "incoming") {
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
	}

	return refs;
}

export function formatFlatReferences(refs: FlatReference[], symbolName: string): string {
	if (refs.length === 0) {
		return `No references found for "${symbolName}".`;
	}

	const lines: string[] = [`## Flat References for \`${symbolName}\` (${refs.length} total)`, ""];

	const incoming = refs.filter((r) => r.direction === "incoming");
	const outgoing = refs.filter((r) => r.direction === "outgoing");

	if (incoming.length > 0) {
		lines.push(`### Incoming (${incoming.length})`);
		for (const r of incoming.slice(0, MAX_DISPLAY_REFS)) {
			lines.push(`- ${r.kind} \`${r.symbol}\` — ${r.file}:${r.line}`);
		}
		if (incoming.length > MAX_DISPLAY_REFS) {
			lines.push(`  ... and ${incoming.length - MAX_DISPLAY_REFS} more (use --maxTokens to see full output)`);
		}
		lines.push("");
	}

	if (outgoing.length > 0) {
		lines.push(`### Outgoing (${outgoing.length})`);
		for (const r of outgoing.slice(0, MAX_DISPLAY_REFS)) {
			lines.push(`- ${r.kind} \`${r.symbol}\` — ${r.file}:${r.line}`);
		}
		if (outgoing.length > MAX_DISPLAY_REFS) {
			lines.push(`  ... and ${outgoing.length - MAX_DISPLAY_REFS} more (use --maxTokens to see full output)`);
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

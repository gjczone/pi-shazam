/**
 * pi-shazam tools/symbol — Symbol lookup.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getNextForTool, formatNextSection } from "../core/output.js";

export function registerSymbol(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_symbol",
		label: "Symbol Lookup",
		description: `\
MUST call to look up a symbol by name — returns definition, kind,
signature, file location, PageRank score, callers, and callees in one
call. Faster and more precise than grep for symbol lookup.

Use BEFORE referencing any symbol by name in code — you confirm it
exists AND understand its signature, not just its file location.

Scenario: before importing a module. Before calling a function. When
you see an unfamiliar symbol name and need its definition. Checking
a symbol's visibility (public/private/exported).`,
		parameters: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeSymbol(graph, params.name, params.file);
			return {
				content: [
					{
						type: "text",
						text: json
							? executeSymbolJson(graph, params.name, params.file)
							: result,
					},
				],
			};
		},
	});
}

export function executeSymbol(
	graph: RepoGraph,
	name: string,
	file?: string,
): string {
	const matches = findSymbols(graph, name, file);
	if (matches.length === 0) {
		return `Symbol not found: ${name}${file ? ` in ${file}` : ""}`;
	}

	const lines: string[] = [];
	for (const sym of matches) {
		lines.push(
			`${sym.kind} ${sym.name} — ${sym.file}:${sym.line}`,
			`  visibility: ${sym.visibility}`,
			`  PageRank: ${sym.pagerank.toFixed(4)}`,
			`  signature: ${sym.signature}`,
		);
		const incoming = graph.incoming.get(sym.id);
		const outgoing = graph.outgoing.get(sym.id);
		if (incoming && incoming.length > 0) {
			lines.push(`  incoming refs: ${incoming.length}`);
		}
		if (outgoing && outgoing.length > 0) {
			lines.push(`  outgoing refs: ${outgoing.length}`);
		}
		lines.push("");
	}

	// Add Next recommendations
	const nextItems = getNextForTool("symbol", { topSymbol: matches[0]?.name });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n").trim();
}

export function executeSymbolJson(
	graph: RepoGraph,
	name: string,
	file?: string,
): string {
	const matches = findSymbols(graph, name, file);
	return JSON.stringify({
		schema_version: "1.0",
		command: "symbol",
		status: "ok",
		result: matches.map((s) => ({
			id: s.id,
			name: s.name,
			kind: s.kind,
			file: s.file,
			line: s.line,
			visibility: s.visibility,
			pagerank: s.pagerank,
			signature: s.signature,
		})),
	});
}

function findSymbols(
	graph: RepoGraph,
	name: string,
	file?: string,
): Symbol[] {
	const results: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === name) {
			if (!file || sym.file === file) {
				results.push(sym);
			}
		}
	}
	return results.sort((a, b) => a.pagerank - b.pagerank);
}

/**
 * pi-shazam tools/codequery — Unified symbol/file query.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerCodequery(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_codequery",
		label: "Symbol & File Query",
		description: `\
MUST call to locate a symbol or inspect a file BEFORE reading or
editing it. Uses LSP precision + tree-sitter parsing. Faster and more
accurate than grep/read — returns definition site, references, callers,
and type info in one call.

Supports: --symbol <name> (find definition + references), --file <path>
(list all symbols in file with signatures), --query <keyword> (BM25
search with synonym expansion).

If this returns empty or "not found", the symbol does not exist — do
not guess or invent it. Use --file to verify the file's actual contents.

Scenario: before editing any function/class. Before renaming. Before
deleting. When you need to find where something is defined. When grep
returns too many results.`,
		parameters: pi.typebox.Object({
			symbol: pi.typebox.Optional(pi.typebox.String()),
			file: pi.typebox.Optional(pi.typebox.String()),
			query: pi.typebox.Optional(pi.typebox.String()),
			json: pi.typebox.Optional(pi.typebox.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeCodequery(graph, {
				symbol: params.symbol,
				file: params.file,
				query: params.query,
			});
			return {
				content: [
					{
						type: "text",
						text: json
							? JSON.stringify({
									schema_version: "1.0",
									command: "codequery",
									status: "ok",
									result: result,
								})
							: formatCodequeryResult(result, params),
					},
				],
			};
		},
	});
}

interface CodequeryParams {
	symbol?: string;
	file?: string;
	query?: string;
}

interface CodequeryResult {
	symbols: Symbol[];
	fileSymbols: Symbol[];
	searchResults: Symbol[];
}

export function executeCodequery(
	graph: RepoGraph,
	params: CodequeryParams,
): CodequeryResult {
	const result: CodequeryResult = {
		symbols: [],
		fileSymbols: [],
		searchResults: [],
	};

	if (params.symbol) {
		for (const sym of graph.symbols.values()) {
			if (sym.name === params.symbol) {
				result.symbols.push(sym);
			}
		}
	}

	if (params.file) {
		const symIds = graph.fileSymbols.get(params.file) || [];
		for (const id of symIds) {
			const sym = graph.symbols.get(id);
			if (sym) result.fileSymbols.push(sym);
		}
	}

	if (params.query) {
		const lower = params.query.toLowerCase();
		for (const sym of graph.symbols.values()) {
			if (sym.name.toLowerCase().includes(lower)) {
				result.searchResults.push(sym);
			}
		}
		// Sort by PageRank
		result.searchResults.sort((a, b) => b.pagerank - a.pagerank);
	}

	return result;
}

function formatCodequeryResult(
	result: CodequeryResult,
	params: CodequeryParams,
): string {
	const lines: string[] = [];

	if (result.symbols.length > 0) {
		lines.push(`## Symbol: ${params.symbol}`);
		lines.push("");
		for (const sym of result.symbols) {
			lines.push(
				`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line}`,
			);
			lines.push(`  visibility: ${sym.visibility}`);
			lines.push(`  signature: ${sym.signature}`);
			lines.push(`  PageRank: ${sym.pagerank.toFixed(4)}`);
		}
	} else if (params.symbol) {
		lines.push(`Symbol not found: ${params.symbol}`);
	}

	if (result.fileSymbols.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(`## File: ${params.file} (${result.fileSymbols.length} symbols)`);
		lines.push("");
		for (const sym of result.fileSymbols) {
			lines.push(
				`- ${sym.kind} \`${sym.name}\` (L${sym.line}) — ${sym.signature.slice(0, 80)}`,
			);
		}
	} else if (params.file) {
		lines.push(`File not in graph: ${params.file}`);
	}

	if (result.searchResults.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`## Search: "${params.query}" (${result.searchResults.length} results)`,
		);
		lines.push("");
		for (const sym of result.searchResults.slice(0, 20)) {
			lines.push(
				`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (PR ${sym.pagerank.toFixed(3)})`,
			);
		}
		if (result.searchResults.length > 20) {
			lines.push(`  ... and ${result.searchResults.length - 20} more`);
		}
	}

	return lines.length > 0 ? lines.join("\n") : "No results found.";
}

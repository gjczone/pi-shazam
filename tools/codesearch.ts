/**
 * pi-shazam tools/codesearch — BM25 symbol search.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerCodesearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_codesearch",
		label: "Code Search (BM25)",
		description: `\
Call to search for symbols by keyword across the entire project using
BM25 relevance ranking with synonym expansion. Returns ranked results:
file:line, symbol name, kind, and snippet.

More semantic than grep — understands camelCase/snake_case tokenization
and ranks by PageRank-weighted relevance, not just substring match.

Scenario: finding error handling patterns. Locating all database query
functions. Searching for "auth" across a multi-language codebase.
Finding usage of a deprecated API before removing it.`,
		parameters: pi.typebox.Object({
			query: pi.typebox.String(),
			topN: pi.typebox.Optional(pi.typebox.Number()),
			json: pi.typebox.Optional(pi.typebox.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeCodesearch(graph, params.query, params.topN);
			return {
				content: [
					{
						type: "text",
						text: json
							? JSON.stringify({
									schema_version: "1.0",
									command: "codesearch",
									status: "ok",
									result: { query: params.query, results: result.length },
								})
							: formatCodesearchResult(result, params.query),
					},
				],
			};
		},
	});
}

export function executeCodesearch(
	graph: RepoGraph,
	query: string,
	topN?: number,
): Symbol[] {
	const limit = topN ?? 20;
	const lower = query.toLowerCase();
	const tokens = tokenize(query);

	const scored: { sym: Symbol; score: number }[] = [];

	for (const sym of graph.symbols.values()) {
		const nameLower = sym.name.toLowerCase();
		let score = 0;

		// Exact match
		if (nameLower === lower) {
			score += 100;
		}

		// Substring match
		if (nameLower.includes(lower)) {
			score += 30;
		}

		// Token matching (camelCase/snake_case)
		for (const token of tokens) {
			if (nameLower.includes(token)) {
				score += 10;
			}
		}

		// PageRank boost
		score += sym.pagerank * 50;

		if (score > 0) {
			scored.push({ sym, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.sym);
}

function tokenize(query: string): string[] {
	const tokens: string[] = [];
	// Split camelCase
	const camelTokens = query.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	// Split snake_case and other separators
	const parts = camelTokens.split(/[\s_\-.:/]+/);
	for (const p of parts) {
		if (p.length >= 2) tokens.push(p);
	}
	return tokens;
}

function formatCodesearchResult(results: Symbol[], query: string): string {
	if (results.length === 0) {
		return `No symbols found for query: "${query}"`;
	}

	const lines: string[] = [
		`## Code Search: "${query}" (${results.length} results)`,
		"",
	];
	for (let i = 0; i < results.length; i++) {
		const sym = results[i]!;
		lines.push(
			`${i + 1}. ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (PR ${sym.pagerank.toFixed(3)})`,
		);
	}
	return lines.join("\n");
}

/**
 * pi-shazam tools/symbol — Symbol lookup with optional LSP enrichment.
 *
 * When LSP documentSymbols are available for the symbol's file, the
 * output is annotated with container (parent symbol) and accurate
 * endLine from LSP range. Falls back to graph data when LSP unavailable.
 */
import type { ExtensionAPI, AgentToolResult } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { lspDocumentSymbols } from "./lsp_enrich.js";
import type { DocumentSymbol } from "vscode-languageserver-protocol";
import { createTool } from "./_factory.js";

export function registerSymbol(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_symbol",
		label: "Symbol Lookup",
		description: `\
MUST call to look up a symbol by name — returns definition, kind,
signature, file location, PageRank score, callers, and callees in one
call. When LSP is available, also shows container (parent symbol)
and accurate endLine. Falls back to graph data when LSP unavailable.

Use BEFORE referencing any symbol by name in code — you confirm it
exists AND understand its signature, not just its file location.

Scenario: before importing a module. Before calling a function. When
you see an unfamiliar symbol name and need its definition. Checking
a symbol's visibility (public/private/exported).`,
		params: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens;
			const graph = scanProject(".");

			const matches = findSymbols(graph, params.name as string, params.file as string | undefined);
			const uniqueFiles = [...new Set(matches.map((m) => m.file))];

			// Fetch LSP documentSymbols for each file in parallel
			const lspManager = getLspManager();
			const hierarchyByFile = new Map<string, DocumentSymbol[]>();
			await Promise.all(
				uniqueFiles.map(async (f) => {
					const syms = await lspDocumentSymbols(lspManager, f, 5000);
					if (Array.isArray(syms) && syms.length > 0 && "children" in syms[0]!) {
						hierarchyByFile.set(f, syms as DocumentSymbol[]);
					}
				}),
			);

			const enriched = matches.map((m) => {
				const h = hierarchyByFile.get(m.file);
				if (h) {
					const hit = locateInHierarchy(h, m.name, m.line - 1);
					if (hit) {
						return {
							sym: m,
							container: hit.container,
							endLine: hit.endLine,
							source: "lsp" as const,
						};
					}
				}
				return { sym: m, container: null, endLine: m.endLine, source: "tree-sitter" as const };
			});

			let text = json
				? JSON.stringify({
						schema_version: "1.0",
						command: "symbol",
						status: "ok",
						result: enriched.map((e) => ({
							id: e.sym.id,
							name: e.sym.name,
							kind: e.sym.kind,
							file: e.sym.file,
							line: e.sym.line,
							endLine: e.endLine,
							visibility: e.sym.visibility,
							pagerank: e.sym.pagerank,
							signature: e.sym.signature,
							container: e.container,
							source: e.source,
						})),
					})
				: formatSymbolResult(enriched, params.name as string);

			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens as number);
			}
			return {
				content: [
					{
						type: "text",
						text,
					},
				],
			};
		},
	});
}

interface EnrichedMatch {
	sym: Symbol;
	container: string | null;
	endLine: number;
	source: "lsp" | "tree-sitter";
}

/**
 * Locate a symbol in the LSP hierarchy by name and line (0-based).
 * Returns container path (e.g., "LspClient > workspaceSymbol") and endLine.
 */
function locateInHierarchy(
	syms: DocumentSymbol[],
	name: string,
	line0: number,
	parentPath: string[] = [],
): { container: string; endLine: number } | null {
	for (const s of syms) {
		const path = [...parentPath, s.name];
		if (s.name === name && s.range.start.line === line0) {
			return {
				container: parentPath.length > 0 ? parentPath.join(" > ") : "(top-level)",
				endLine: s.range.end.line + 1,
			};
		}
		if (s.children && s.children.length > 0) {
			const hit = locateInHierarchy(s.children, name, line0, path);
			if (hit) return hit;
		}
	}
	return null;
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
	return results.sort((a, b) => b.pagerank - a.pagerank);
}

/**
 * Backward-compatible synchronous symbol lookup (no LSP enrichment).
 * Used by tests and callers that need a string result without awaiting.
 */
export function executeSymbol(
	graph: RepoGraph,
	name: string,
	file?: string,
): string {
	const matches = findSymbols(graph, name, file);
	const enriched: EnrichedMatch[] = matches.map((m) => ({
		sym: m,
		container: null,
		endLine: m.endLine,
		source: "tree-sitter",
	}));
	return formatSymbolResult(enriched, name);
}

/**
 * Backward-compatible JSON output (no LSP enrichment).
 */
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
			endLine: s.endLine,
			visibility: s.visibility,
			pagerank: s.pagerank,
			signature: s.signature,
			container: null,
			source: "tree-sitter",
		})),
	});
}

function formatSymbolResult(matches: EnrichedMatch[], name: string): string {
	if (matches.length === 0) {
		return `Symbol not found: ${name}`;
	}

	const hasLsp = matches.some((m) => m.source === "lsp");
	const sourceLabel = hasLsp ? " (LSP enriched)" : " (tree-sitter only)";
	const lines: string[] = [
		`## Symbol: \`${name}\` (${matches.length} matches)${sourceLabel}`,
		"",
	];

	for (const e of matches) {
		const s = e.sym;
		lines.push(
			`${s.kind} \`${s.name}\` — ${s.file}:${s.line}-${e.endLine} [${s.visibility}]`,
		);
		if (e.container) {
			lines.push(`  container: ${e.container}`);
		}
		lines.push(`  PageRank: ${s.pagerank.toFixed(4)}`);
		lines.push(`  signature: ${s.signature}`);
		lines.push("");
	}

	const nextItems = getNextForTool("symbol", { topSymbol: matches[0]?.sym.name });
	if (nextItems.length > 0) {
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n").trim();
}

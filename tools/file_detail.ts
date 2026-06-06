/**
 * pi-shazam tools/file_detail — Single file deep analysis.
 *
 * When LSP is available, augments tree-sitter symbol list with a
 * parent-child hierarchy section from documentSymbol. Falls back to
 * flat list with "(tree-sitter only)" annotation when LSP unavailable.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { lspDocumentSymbols } from "./lsp_enrich.js";
import type { DocumentSymbol } from "vscode-languageserver-protocol";

export function registerFileDetail(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_file_detail",
		label: "File Deep Analysis",
		description: `\
Call to get a complete structural breakdown of a single file: all
symbols (functions, classes, types, constants) with signatures,
visibility, line ranges, incoming call count, and PageRank score.
When LSP is available, also shows parent-child symbol hierarchy.

MUST call before making edits to an unfamiliar file — reading the raw
file shows you syntax, this shows you STRUCTURE. You will spot
dependencies and side effects that raw reading misses.

Scenario: before editing a file for the first time. Before refactoring
a large file. When deciding where to add a new function (PageRank shows
you the file's "gravity"). After someone else's PR to understand what
changed structurally.`,
		parameters: Type.Object({
			file: Type.String(),
			json: Type.Optional(Type.Boolean()),
			maxTokens: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens;
			const graph = scanProject(".");

			// Fetch LSP hierarchy in parallel with graph-based detail
			const detailPromise = Promise.resolve(
				json
					? executeFileDetailJson(graph, params.file)
					: executeFileDetail(graph, params.file),
			);
			const lspManager = getLspManager();
			const hierarchyPromise = lspDocumentSymbols(lspManager, params.file, 5000);

			const [detailText, lspSymbols] = await Promise.all([
				detailPromise,
				hierarchyPromise,
			]);

			let text = detailText;
			if (!json && Array.isArray(lspSymbols) && lspSymbols.length > 0 && isDocumentSymbols(lspSymbols)) {
				const hierarchy = formatHierarchy(lspSymbols, 0).join("\n");
				// Insert hierarchy section before "### Next" or at end
				const nextIdx = text.indexOf("\n### Next");
				const section = `\n### Symbol Hierarchy (LSP enriched)\n\n${hierarchy}\n`;
				if (nextIdx >= 0) {
					text = text.slice(0, nextIdx) + section + text.slice(nextIdx);
				} else {
					text = text + "\n" + section;
				}
			} else if (!json) {
				// Append tree-sitter-only note if not already present
				if (!text.includes("(tree-sitter only)")) {
					text = text + "\n\n*Symbol hierarchy unavailable (tree-sitter only, LSP unavailable).*";
				}
			}

			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens);
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

function isDocumentSymbols(
	syms: DocumentSymbol[] | import("vscode-languageserver-protocol").SymbolInformation[],
): syms is DocumentSymbol[] {
	return syms.length > 0 && "range" in syms[0]! && "children" in syms[0]!;
}

function formatHierarchy(syms: DocumentSymbol[], depth: number): string[] {
	const out: string[] = [];
	const indent = "  ".repeat(depth);
	for (const s of syms) {
		const startLine = s.range.start.line + 1;
		const endLine = s.range.end.line + 1;
		out.push(`${indent}- \`${s.name}\` L${startLine}-${endLine}`);
		if (s.children && s.children.length > 0) {
			out.push(...formatHierarchy(s.children, depth + 1));
		}
	}
	return out;
}

export function executeFileDetail(graph: RepoGraph, file: string): string {
	const symIds = graph.fileSymbols.get(file);
	if (!symIds || symIds.length === 0) {
		return `File not found in graph or has no symbols: ${file}`;
	}

	const symbols = symIds
		.map((id) => graph.symbols.get(id))
		.filter((s): s is NonNullable<typeof s> => s !== undefined)
		.sort((a, b) => a.line - b.line || a.col - b.col);

	const lines: string[] = [];
	lines.push(`## File: ${file} (${symbols.length} symbols)`);
	lines.push("");

	// Summary stats
	const byKind = new Map<string, number>();
	let totalPR = 0;
	let totalIncoming = 0;
	let totalOutgoing = 0;
	for (const sym of symbols) {
		byKind.set(sym.kind, (byKind.get(sym.kind) || 0) + 1);
		totalPR += sym.pagerank;
		const inc = graph.incoming.get(sym.id);
		const out = graph.outgoing.get(sym.id);
		totalIncoming += inc ? inc.length : 0;
		totalOutgoing += out ? out.length : 0;
	}

	lines.push("### Summary");
	lines.push(`Total PageRank: ${totalPR.toFixed(4)}`);
	lines.push(`Incoming refs: ${totalIncoming}`);
	lines.push(`Outgoing refs: ${totalOutgoing}`);
	lines.push("");
	lines.push(
		"Kinds: " +
			[...byKind.entries()]
				.map(([k, v]) => `${v} ${k}`)
				.join(", "),
	);
	lines.push("");

	// Symbol list
	lines.push("### Symbols");
	lines.push("");
	for (const sym of symbols) {
		const inc = graph.incoming.get(sym.id);
		const out = graph.outgoing.get(sym.id);
		const incCount = inc ? inc.length : 0;
		const outCount = out ? out.length : 0;
		lines.push(
			`- ${sym.kind} \`${sym.name}\` L${sym.line}-${sym.endLine} [${sym.visibility}] PR ${sym.pagerank.toFixed(3)} | in:${incCount} out:${outCount}`,
		);
		lines.push(`  ${sym.signature.slice(0, 100)}`);
	}

	// File-level imports
	const fileImports = graph.fileImports.get(file);
	if (fileImports && fileImports.length > 0) {
		lines.push("");
		lines.push("### Imports");
		for (const imp of fileImports.slice(0, 20)) {
			lines.push(`- ${imp}`);
		}
	}

	// Add Next recommendations
	const nextItems = getNextForTool("file_detail", { topFile: file, topSymbol: symbols[0]?.name });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

export function executeFileDetailJson(
	graph: RepoGraph,
	file: string,
): string {
	const symIds = graph.fileSymbols.get(file) || [];
	const symbols = symIds
		.map((id) => graph.symbols.get(id))
		.filter((s): s is NonNullable<typeof s> => s !== undefined);

	return JSON.stringify({
		schema_version: "1.0",
		command: "file_detail",
		status: "ok",
		result: {
			file,
			symbolCount: symbols.length,
			symbols: symbols.map((s) => ({
				id: s.id,
				name: s.name,
				kind: s.kind,
				line: s.line,
				endLine: s.endLine,
				visibility: s.visibility,
				pagerank: Number(s.pagerank.toFixed(4)),
				signature: s.signature,
				incomingCount: (graph.incoming.get(s.id) || []).length,
				outgoingCount: (graph.outgoing.get(s.id) || []).length,
			})),
		},
	});
}

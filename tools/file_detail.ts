/**
 * pi-shazam tools/file_detail — Single file deep analysis.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getNextForTool, formatNextSection } from "../core/output.js";

export function registerFileDetail(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_file_detail",
		label: "File Deep Analysis",
		description: `\
Call to get a complete structural breakdown of a single file: all
symbols (functions, classes, types, constants) with signatures,
visibility, line ranges, incoming call count, and PageRank score.
Also returns LSP symbol tree when available.

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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeFileDetail(graph, params.file);
			return {
				content: [
					{
						type: "text",
						text: json
							? executeFileDetailJson(graph, params.file)
							: result,
					},
				],
			};
		},
	});
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

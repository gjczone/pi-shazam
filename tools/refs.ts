/**
 * pi-shazam tools/refs — Reference finder.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerRefs(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_refs",
		label: "Find References",
		description: `\
Call to find EVERY reference to a symbol (function, class, variable,
type) across the entire project. Uses LSP references + tree-sitter
fallback. Returns file:line:context for each usage.

MUST call BEFORE renaming, deleting, or changing visibility of any
symbol. A reference you miss is a broken import or a runtime crash.

Scenario: renaming a variable. Changing a function from public to
private. Deleting dead code (confirm zero references first). Checking
if a deprecated function still has callers.`,
		parameters: pi.typebox.Object({
			symbol: pi.typebox.String(),
			file: pi.typebox.Optional(pi.typebox.String()),
			line: pi.typebox.Optional(pi.typebox.Number()),
			json: pi.typebox.Optional(pi.typebox.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeRefs(graph, params.symbol, params.file);
			return {
				content: [
					{
						type: "text",
						text: json
							? executeRefsJson(graph, params.symbol, params.file)
							: result,
					},
				],
			};
		},
	});
}

export function executeRefs(
	graph: RepoGraph,
	symbolName: string,
	file?: string,
): string {
	// Find the symbol first
	const targetSyms = findSymbols(graph, symbolName, file);
	if (targetSyms.length === 0) {
		return `Symbol not found: ${symbolName}${file ? ` in ${file}` : ""}`;
	}

	const lines: string[] = [];
	for (const target of targetSyms) {
		lines.push(
			`## References to ${target.kind} \`${target.name}\` (${target.file}:${target.line})`,
		);
		lines.push("");

		// Incoming references (who references this symbol)
		const incoming = graph.incoming.get(target.id);
		if (incoming && incoming.length > 0) {
			lines.push(`### Incoming (${incoming.length} references)`);
			for (const edge of incoming) {
				const srcSym = graph.symbols.get(edge.source);
				if (srcSym) {
					lines.push(
						`- ${srcSym.kind} \`${srcSym.name}\` — ${srcSym.file}:${srcSym.line} (${edge.kind})`,
					);
				}
			}
		} else {
			lines.push("### Incoming: 0 references");
		}

		// Outgoing references (what this symbol references)
		const outgoing = graph.outgoing.get(target.id);
		if (outgoing && outgoing.length > 0) {
			lines.push("");
			lines.push(`### Outgoing (${outgoing.length} references)`);
			for (const edge of outgoing) {
				const tgtSym = graph.symbols.get(edge.target);
				if (tgtSym) {
					lines.push(
						`- ${tgtSym.kind} \`${tgtSym.name}\` — ${tgtSym.file}:${tgtSym.line} (${edge.kind})`,
					);
				}
			}
		}
		lines.push("");
	}

	return lines.join("\n").trim();
}

export function executeRefsJson(
	graph: RepoGraph,
	symbolName: string,
	file?: string,
): string {
	const targets = findSymbols(graph, symbolName, file);
	const result = targets.map((target) => {
		const incoming = graph.incoming.get(target.id) || [];
		const outgoing = graph.outgoing.get(target.id) || [];
		return {
			symbol: {
				id: target.id,
				name: target.name,
				kind: target.kind,
				file: target.file,
				line: target.line,
			},
			incomingCount: incoming.length,
			outgoingCount: outgoing.length,
			incoming: incoming.slice(0, 50).map((e) => {
				const src = graph.symbols.get(e.source);
				return {
					from: src?.name ?? e.source,
					file: src?.file ?? "?",
					kind: e.kind,
				};
			}),
			outgoing: outgoing.slice(0, 50).map((e) => {
				const tgt = graph.symbols.get(e.target);
				return {
					to: tgt?.name ?? e.target,
					file: tgt?.file ?? "?",
					kind: e.kind,
				};
			}),
		};
	});

	return JSON.stringify({
		schema_version: "1.0",
		command: "refs",
		status: "ok",
		result,
	});
}

function findSymbols(
	graph: RepoGraph,
	name: string,
	file?: string,
): Symbol[] {
	const results: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === name && (!file || sym.file === file)) {
			results.push(sym);
		}
	}
	return results;
}

/**
 * pi-shazam tools/symbol — Symbol lookup with optional LSP enrichment.
 *
 * Supports two modes:
 *   - default: standard symbol lookup with definition, kind, signature, callers, callees
 *   - state:   state map analysis for enum/class/interface/type_alias/const symbols
 *              (absorbed from tools/state_map.ts)
 *
 * When LSP documentSymbols are available for the symbol's file, the
 * output is annotated with container (parent symbol) and accurate
 * endLine from LSP range. Falls back to graph data when LSP unavailable.
 * State mode bypasses LSP enrichment and uses graph-only analysis.
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
import { buildEnvelope } from "./_factory.js";

// ── State map (absorbed from tools/state_map.ts) ────────────────────────

const STATE_MAP_KINDS = new Set(["enum", "class", "interface", "type_alias", "const"]);

export function registerSymbol(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_symbol",
		label: "Symbol Lookup",
		description: `\
		When you need to look up a symbol before importing or calling it —
		returns definition, kind, signature, file location, PageRank score,
		callers, and callees in one call. Better than file_detail when you
		know the symbol name but not its location. When LSP is available, also
		shows container (parent symbol) and accurate endLine.
		
		Supports --mode state for state map analysis: filter to
		enum/class/interface/type_alias/const kinds and show members, usage,
		and dependencies. Use mode=state before adding/removing enum variants
		or changing state transitions.`,
		params: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
			mode: Type.Optional(Type.String()),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens;
			const mode = (params.mode as string) ?? "default";
			const name = typeof params.name === "string" ? params.name : "";
			if (!name) {
				return { content: [{ type: "text", text: "Error: name parameter is required" }] };
			}

			// State mode: bypass LSP, use graph-only state map analysis
			if (mode === "state") {
				const graph = scanProject(".");
				const result = executeStateMap(graph, name);
				let text = json
					? buildEnvelope("shazam_symbol", process.cwd(), "ok", { symbol: name, mode: "state", text: result })
					: result;
				if (maxTokens && !json) {
					text = truncateOutput(text.split("\n"), maxTokens as number);
				}
				return { content: [{ type: "text", text }] };
			}

			const graph = scanProject(".");

			const matches = findSymbols(graph, name, params.file as string | undefined);
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
				? buildEnvelope(
						"shazam_symbol",
						process.cwd(),
						"ok",
						enriched.map((e) => ({
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
					)
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

function findSymbols(graph: RepoGraph, name: string, file?: string): Symbol[] {
	// Use nameIndex for O(1) lookup, avoid traversing all symbols
	const candidates = graph.nameIndex.get(name) ?? [];
	const results = file ? candidates.filter((sym) => sym.file === file) : [...candidates];
	return results.sort((a, b) => b.pagerank - a.pagerank);
}

/**
 * Backward-compatible synchronous symbol lookup (no LSP enrichment).
 * Used by tests and callers that need a string result without awaiting.
 */
export function executeSymbol(graph: RepoGraph, name: string, file?: string): string {
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
 * Backward-compatible symbol lookup with mode support.
 * When mode is "state", returns state map output.
 */
export function executeSymbolWithMode(graph: RepoGraph, name: string, mode?: string, file?: string): string {
	if (mode === "state") {
		return executeStateMap(graph, name);
	}
	return executeSymbol(graph, name, file);
}

/**
 * Backward-compatible JSON output (no LSP enrichment).
 */
export function executeSymbolJson(graph: RepoGraph, name: string, file?: string): string {
	const matches = findSymbols(graph, name, file);
	return buildEnvelope(
		"shazam_symbol",
		process.cwd(),
		"ok",
		matches.map((s) => ({
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
	);
}

function formatSymbolResult(matches: EnrichedMatch[], name: string): string {
	if (matches.length === 0) {
		return `Symbol not found: ${name}`;
	}

	const hasLsp = matches.some((m) => m.source === "lsp");
	const sourceLabel = hasLsp ? " (LSP enriched)" : " (tree-sitter only)";
	const lines: string[] = [`## Symbol: \`${name}\` (${matches.length} matches)${sourceLabel}`, ""];

	for (const e of matches) {
		const s = e.sym;
		lines.push(`${s.kind} \`${s.name}\` — ${s.file}:${s.line}-${e.endLine} [${s.visibility}]`);
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

// ── State map analysis (absorbed from tools/state_map.ts) ───────────────

/**
 * Execute state map analysis for a given symbol name.
 * Filters to STATE_MAP_KINDS and shows members, usage, and dependencies.
 */
export function executeStateMap(graph: RepoGraph, symbolName: string): string {
	const targets: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === symbolName) {
			targets.push(sym);
		}
	}

	if (targets.length === 0) {
		return `Symbol not found: ${symbolName}`;
	}

	const lines: string[] = [];
	for (const target of targets) {
		// Check if symbol kind is eligible for state map analysis
		if (!STATE_MAP_KINDS.has(target.kind)) {
			lines.push(`## ${target.kind} \`${target.name}\` — cannot generate state map`);
			lines.push("");
			lines.push(`Symbol \`${target.name}\` is a ${target.kind}, not an enum, const group, or state machine.`);
			lines.push(
				"State map analysis requires: enum, class (constants/state machine), interface, type_alias (union type), or const.",
			);
			lines.push("");
			lines.push(
				`Use \`shazam_symbol --name ${target.name}\` or \`shazam_call_chain --symbol ${target.name} --flat\` instead.`,
			);
			continue;
		}

		lines.push(`## State Map: ${target.kind} \`${target.name}\` (${target.file}:${target.line})`);
		lines.push("");

		const incoming = graph.incoming.get(target.id) || [];
		const outgoing = graph.outgoing.get(target.id) || [];

		if (incoming.length > 0) {
			lines.push(`### Usages (${incoming.length} references from other symbols)`);
			const byFile = new Map<string, Symbol[]>();
			for (const edge of incoming) {
				const sym = graph.symbols.get(edge.source);
				if (sym) {
					const arr = byFile.get(sym.file) || [];
					arr.push(sym);
					byFile.set(sym.file, arr);
				}
			}
			for (const [file, syms] of [...byFile.entries()].sort()) {
				lines.push(`  **${file}**: ${syms.map((s) => s.name).join(", ")}`);
			}
		}

		if (outgoing.length > 0) {
			lines.push("");
			lines.push(`### Dependencies (${outgoing.length} symbols this depends on)`);
			for (const edge of outgoing) {
				const sym = graph.symbols.get(edge.target);
				if (sym) {
					lines.push(`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line}`);
				}
			}
		}

		lines.push("");
		lines.push(`Visibility: ${target.visibility}`);
		lines.push(`PageRank: ${target.pagerank.toFixed(4)}`);
		lines.push(`Signature: ${target.signature}`);
	}

	// Add Next recommendations
	const nextItems = getNextForTool("symbol", { usageFile: targets[0]?.file });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

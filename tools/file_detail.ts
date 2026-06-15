/**
 * pi-shazam tools/file_detail — Single file deep analysis.
 *
 * When LSP is available, augments tree-sitter symbol list with a
 * parent-child hierarchy section from documentSymbol. Falls back to
 * flat list with "(tree-sitter only)" annotation when LSP unavailable.
 */
import { statSync } from "node:fs";
import type { ExtensionAPI, AgentToolResult } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { lspDocumentSymbols, lspCodeLens } from "./lsp_enrich.js";
import type { DocumentSymbol } from "vscode-languageserver-protocol";
import { createTool } from "./_factory.js";
import { buildEnvelope } from "./_factory.js";

/**
 * Cache for file detail results within a session.
 * Key: file path, Value: { text, timestamp, mtimeMs }
 * Cache is invalidated when file mtime changes or TTL expires.
 */
const MAX_DETAIL_CACHE_SIZE = 200;
const fileDetailCache = new Map<string, { text: string; timestamp: number; mtimeMs: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function registerFileDetail(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_file_detail",
		label: "File Deep Analysis",
		description: `\
		When you are about to edit a file you have not read before — this
		shows structure (symbols, signatures, visibility, PageRank scores,
		call counts), not just syntax. A raw file read shows characters; this
		shows architecture. Also surfaces LSP document symbol hierarchy for
		parent-child relationships.`,
		params: Type.Object({
			file: Type.String(),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens;
			const file = typeof params.file === "string" ? params.file : "";
			if (!file) {
				return { content: [{ type: "text", text: "Error: file parameter is required" }] };
			}

			// Check cache first (fixes #119, invalidates on mtime change #174)
			const cacheKey = `${file}:${json ? "json" : "text"}`;
			const cached = fileDetailCache.get(cacheKey);
			if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
				// Verify file hasn't been modified since caching
				try {
					const st = statSync(file);
					if (st.mtimeMs === cached.mtimeMs) {
						return { content: [{ type: "text", text: cached.text }] };
					}
					// File modified — evict stale entry
					fileDetailCache.delete(cacheKey);
				} catch {
					// File may not exist — use cached value if TTL valid
					return { content: [{ type: "text", text: cached.text }] };
				}
			}

			const graph = scanProject(".");

			// Fetch LSP hierarchy in parallel with graph-based detail
			const detailPromise = Promise.resolve(json ? executeFileDetailJson(graph, file) : executeFileDetail(graph, file));
			const lspManager = getLspManager();
			const hierarchyPromise = lspDocumentSymbols(lspManager, file, 5000);
			const codeLensPromise = lspCodeLens(lspManager, file, 5000);

			const [detailText, lspSymbols, codeLens] = await Promise.all([detailPromise, hierarchyPromise, codeLensPromise]);

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

			// Inject codeLens reference counts
			if (!json && codeLens && codeLens.length > 0) {
				const refLines: string[] = [];
				for (const cl of codeLens) {
					const line = cl.range.start.line + 1;
					const title = cl.command?.title || "";
					refLines.push(`- L${line}: ${title}`);
				}
				if (refLines.length > 0) {
					const section = `\n### Reference Counts (LSP CodeLens)\n\n${refLines.join("\n")}\n`;
					const nextIdx = text.indexOf("\n### Next");
					if (nextIdx >= 0) {
						text = text.slice(0, nextIdx) + section + text.slice(nextIdx);
					} else {
						text = text + "\n" + section;
					}
				}
			}

			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens as number);
			}

			// Cache the result with file mtime for invalidation
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(file).mtimeMs;
			} catch {
				// File may not exist — cache with mtime 0
			}
			if (fileDetailCache.size >= MAX_DETAIL_CACHE_SIZE) {
				const firstKey = fileDetailCache.keys().next().value;
				if (firstKey !== undefined) fileDetailCache.delete(firstKey);
			}
			fileDetailCache.set(cacheKey, { text, timestamp: Date.now(), mtimeMs });

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

// LSP SymbolKind constants
const SYMBOL_KIND_VARIABLE = 13;
const SYMBOL_KIND_CONSTANT = 14;

// Kinds that represent local variables/consts inside function bodies
const LOCAL_KINDS = new Set([SYMBOL_KIND_VARIABLE, SYMBOL_KIND_CONSTANT]);

/**
 * Format LSP document symbol hierarchy, filtering out local variables.
 * Only shows function/method signatures, type definitions, and exported symbols.
 * This reduces output verbosity significantly (fixes #106).
 */
function formatHierarchy(syms: DocumentSymbol[], depth: number): string[] {
	const out: string[] = [];
	const indent = "  ".repeat(depth);
	for (const s of syms) {
		// Skip local variables and constants (implementation details)
		if (depth > 0 && LOCAL_KINDS.has(s.kind)) continue;

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
	lines.push("Kinds: " + [...byKind.entries()].map(([k, v]) => `${v} ${k}`).join(", "));
	lines.push("");

	// Symbol list with tree-sitter nesting grouping
	// Group container symbols (class, interface, impl, struct, module, namespace)
	// and nest their member functions
	lines.push("### Symbols");
	lines.push("");

	const CONTAINER_KINDS = new Set(["class", "interface", "struct", "impl", "module", "namespace", "object"]);
	const containers: { sym: (typeof symbols)[0]; members: typeof symbols }[] = [];
	const standalone: typeof symbols = [];

	for (const sym of symbols) {
		if (CONTAINER_KINDS.has(sym.kind)) {
			// Find members that are within this container's line range
			const members = symbols.filter((other) => {
				if (other.id === sym.id) return false;
				// A member is between the container's start and end lines
				return other.line >= sym.line && other.endLine <= sym.endLine;
			});
			if (members.length > 0) {
				containers.push({ sym, members });
			} else {
				standalone.push(sym);
			}
		} else {
			standalone.push(sym);
		}
	}

	// If we have containers with members, show tree-sitter hierarchy
	if (containers.length > 0) {
		for (const { sym, members } of containers) {
			const inc = graph.incoming.get(sym.id);
			const out = graph.outgoing.get(sym.id);
			const incCount = inc ? inc.length : 0;
			const outCount = out ? out.length : 0;
			lines.push(
				`- container ${sym.kind} \`${sym.name}\` L${sym.line}-${sym.endLine} | in:${incCount} out:${outCount}`,
			);
			for (const member of members) {
				const mInc = graph.incoming.get(member.id);
				const mOut = graph.outgoing.get(member.id);
				const mIncCount = mInc ? mInc.length : 0;
				const mOutCount = mOut ? mOut.length : 0;
				lines.push(
					`  └ ${member.kind} \`${member.name}\` L${member.line}-${member.endLine} [${member.visibility}] PR ${member.pagerank.toFixed(3)} | in:${mIncCount} out:${mOutCount}`,
				);
			}
		}
		// Add standalone symbols (not in any container)
		const memberIds = new Set(containers.flatMap(({ members }) => members.map((m) => m.id)));
		const filteredStandalone = standalone.filter((sym) => !memberIds.has(sym.id));
		if (filteredStandalone.length > 0) {
			lines.push("");
			lines.push("Other symbols:");
			for (const sym of filteredStandalone) {
				const inc = graph.incoming.get(sym.id);
				const out = graph.outgoing.get(sym.id);
				const incCount = inc ? inc.length : 0;
				const outCount = out ? out.length : 0;
				lines.push(
					`  - ${sym.kind} \`${sym.name}\` L${sym.line}-${sym.endLine} [${sym.visibility}] PR ${sym.pagerank.toFixed(3)} | in:${incCount} out:${outCount}`,
				);
			}
		}
	} else {
		// Flat list (no containers found)
		for (const sym of symbols) {
			const inc = graph.incoming.get(sym.id);
			const out = graph.outgoing.get(sym.id);
			const incCount = inc ? inc.length : 0;
			const outCount = out ? out.length : 0;
			lines.push(
				`- ${sym.kind} \`${sym.name}\` L${sym.line}-${sym.endLine} [${sym.visibility}] PR ${sym.pagerank.toFixed(3)} | in:${incCount} out:${outCount}`,
			);
			if (sym.signature) {
				lines.push(`  ${sym.signature.slice(0, 100)}`);
			}
		}
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
	const hasHierarchyTypes = symbols.some((s) => ["class", "interface", "struct", "impl"].includes(s.kind));
	const nextItems = getNextForTool("file_detail", {
		topFile: file,
		topSymbol: symbols[0]?.name,
	});

	// Add type_hierarchy recommendation if file has class/interface symbols (Phase 3)
	if (hasHierarchyTypes) {
		const typeSym = symbols.find((s) => ["class", "interface", "struct"].includes(s.kind));
		if (typeSym) {
			nextItems.push({
				tool: "type_hierarchy",
				params: { name: typeSym.name },
				label: `Explore type hierarchy for ${typeSym.name}`,
				level: "recommended",
			});
		}
	}

	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

export function executeFileDetailJson(graph: RepoGraph, file: string): string {
	const symIds = graph.fileSymbols.get(file) || [];
	const symbols = symIds.map((id) => graph.symbols.get(id)).filter((s): s is NonNullable<typeof s> => s !== undefined);

	return buildEnvelope("shazam_file_detail", process.cwd(), "ok", {
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
	});
}

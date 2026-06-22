/**
 * pi-shazam tools/lookup — Unified symbol/file lookup tool.
 *
 * Merges four tools into one interface (issue #362):
 *   - symbol:      graph-based symbol lookup with LSP document symbol enrichment
 *   - file_detail: file structure analysis with caching and LSP code lens
 *   - hover:       symbol type info via LSP hover + docstring extraction
 *   - type_hierarchy: inheritance chain via LSP typeHierarchy protocol
 *
 * Auto-detects file path vs symbol name to dispatch appropriately.
 * Anonymous callback functions are collapsed by default; pass
 * showCallbacks: true to expand them.
 */
import type { ExtensionAPI, AgentToolResult } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { lspDocumentSymbols, lspCodeLens, lspImplementation } from "./lsp_enrich.js";
import type { DocumentSymbol } from "vscode-languageserver-protocol";
import { createTool } from "./_factory.js";
import { buildEnvelope } from "./_factory.js";
import { statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TreeSitterAdapter } from "../core/treesitter.js";
import { uriToPath } from "../lsp/client.js";

// ── State map kinds (from symbol.ts) ─────────────────────────────────────

const STATE_MAP_KINDS = new Set(["enum", "class", "interface", "type_alias", "const"]);

// ── File detail cache (from file_detail.ts) ─────────────────────────────

const MAX_DETAIL_CACHE_SIZE = 200;
const fileDetailCache = new Map<string, { text: string; timestamp: number; mtimeMs: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── LSP SymbolKind constants ─────────────────────────────────────────────

const LOCAL_KINDS = new Set([13, 14]);

// ── Registration ─────────────────────────────────────────────────────────

export function registerLookup(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_lookup",
		label: "Lookup Symbol or File",
		description: `\
		Look up anything in the codebase — a symbol by name or a file by path.
		Auto-detects whether the input is a file path or symbol name and returns
		the most relevant information: definition, kind, signature, type hierarchy,
		file structure, PageRank, callers/callees. Use mode=state for enum/state
		analysis. Pass showCallbacks=true to expand anonymous functions.`,
		params: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
			mode: Type.Optional(Type.String()),
			showCallbacks: Type.Optional(Type.Boolean()),
			direction: Type.Optional(
				Type.Union([Type.Literal("both"), Type.Literal("supertypes"), Type.Literal("subtypes")]),
			),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens;
			const mode = (params.mode as string) ?? "default";
			const name = typeof params.name === "string" ? params.name : "";
			if (!name) {
				return { content: [{ type: "text", text: "Error: name parameter is required" }] };
			}

			const graph = scanProject(".");

			let text: string;

			if (_isFilePath(name)) {
				text = json
					? _executeFileDetailJson(graph, name)
					: await _executeFileDetailAsync(graph, name, Boolean(json), maxTokens as number | undefined);
			} else if (mode === "state") {
				text = _executeStateMap(graph, name);
				if (json) {
					text = buildEnvelope("shazam_lookup", process.cwd(), "ok", { symbol: name, mode: "state", text });
				}
			} else {
				text = json
					? _executeSymbolJson(graph, name, params.file as string | undefined)
					: await _executeLookupAsync(
							graph,
							name,
							params.file as string | undefined,
							(params.direction as "both" | "supertypes" | "subtypes") ?? "both",
							(params.showCallbacks as boolean) ?? false,
						);
			}

			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens as number);
			}
			return { content: [{ type: "text", text }] };
		},
	});
}

// ── Dispatch helper ──────────────────────────────────────────────────────

function _isFilePath(name: string): boolean {
	return (
		name.includes("/") ||
		name.includes("\\") ||
		/\.(ts|tsx|js|jsx|py|go|rs|dart|json|mjs|cjs|rb|java|cs|c|cpp|h|hpp)$/.test(name)
	);
}

// ── Symbol lookup (from symbol.ts + hover.ts + type_hierarchy.ts) ────────

interface EnrichedMatch {
	sym: Symbol;
	container: string | null;
	endLine: number;
	source: "lsp" | "tree-sitter";
}

function _findSymbols(graph: RepoGraph, name: string, file?: string): Symbol[] {
	const candidates = graph.nameIndex.get(name) ?? [];
	const results = file ? candidates.filter((sym) => sym.file === file) : [...candidates];
	return results.sort((a, b) => b.pagerank - a.pagerank);
}

function _locateInHierarchy(
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
			const hit = _locateInHierarchy(s.children, name, line0, path);
			if (hit) return hit;
		}
	}
	return null;
}

async function _executeLookupAsync(
	graph: RepoGraph,
	name: string,
	file: string | undefined,
	direction: "both" | "supertypes" | "subtypes",
	showCallbacks: boolean,
): Promise<string> {
	const matches = _findSymbols(graph, name, file);
	if (matches.length === 0) {
		return `Symbol not found: ${name}`;
	}

	const uniqueFiles = [...new Set(matches.map((m) => m.file))];
	const lspManager = getLspManager();

	// Fetch LSP documentSymbols for each file in parallel
	const hierarchyByFile = new Map<string, DocumentSymbol[]>();
	await Promise.all(
		uniqueFiles.map(async (f) => {
			const syms = await lspDocumentSymbols(lspManager, f, 5000);
			if (Array.isArray(syms) && syms.length > 0 && "children" in syms[0]!) {
				hierarchyByFile.set(f, syms as DocumentSymbol[]);
			}
		}),
	);

	const enriched: EnrichedMatch[] = matches.map((m) => {
		const h = hierarchyByFile.get(m.file);
		if (h) {
			const hit = _locateInHierarchy(h, m.name, m.line - 1);
			if (hit) {
				return { sym: m, container: hit.container, endLine: hit.endLine, source: "lsp" as const };
			}
		}
		return { sym: m, container: null, endLine: m.endLine, source: "tree-sitter" as const };
	});

	// Filter anonymous callbacks unless showCallbacks is true
	const namedMatches = showCallbacks ? enriched : enriched.filter((e) => e.sym.kind !== "anonymous_function");
	const collapsedCount = enriched.length - namedMatches.length;

	const lines: string[] = [];
	const hasLsp = enriched.some((m) => m.source === "lsp");
	const sourceLabel = hasLsp ? " (LSP enriched)" : " (tree-sitter only)";
	lines.push(
		`## Lookup: \`${name}\` (${namedMatches.length} matches${collapsedCount > 0 ? `, ${collapsedCount} anonymous collapsed` : ""})${sourceLabel}`,
	);
	lines.push("");

	for (const e of namedMatches) {
		const s = e.sym;
		lines.push(`${s.kind} \`${s.name}\` — ${s.file}:${s.line}-${e.endLine} [${s.visibility}]`);
		if (e.container) lines.push(`  container: ${e.container}`);
		lines.push(`  PageRank: ${s.pagerank.toFixed(4)}`);
		lines.push(`  signature: ${s.signature}`);

		// Hover info (inline, from hover.ts)
		const hoverInfo = await _getHoverInfo(s);
		if (hoverInfo.lspHover) {
			lines.push(`  hover: ${hoverInfo.lspHover.split("\n")[0]!.slice(0, 120)}`);
		} else if (hoverInfo.docstring) {
			lines.push(`  docs: ${hoverInfo.docstring.split("\n")[0]!.slice(0, 120)}`);
		}

		// Incoming/outgoing counts
		const incoming = graph.incoming.get(s.id);
		const outgoing = graph.outgoing.get(s.id);
		const incCount = incoming ? incoming.length : 0;
		const outCount = outgoing ? outgoing.length : 0;
		lines.push(`  refs: in:${incCount} out:${outCount}`);
		lines.push("");
	}

	// Type hierarchy for first class/interface/type symbol
	const typeSym = matches.find((s) => ["class", "interface", "type_alias", "struct"].includes(s.kind));
	if (typeSym) {
		const hierarchy = await _getTypeHierarchy(graph, typeSym, direction);
		if (hierarchy.supertypes.length > 0 || hierarchy.subtypes.length > 0 || hierarchy.implementations.length > 0) {
			lines.push("### Type Hierarchy");
			lines.push("");
			if (hierarchy.supertypes.length > 0) {
				lines.push(`Supertypes (${hierarchy.supertypes.length}):`);
				for (const st of hierarchy.supertypes) lines.push(`  - ${st.kind} \`${st.name}\` — ${st.file}:${st.line}`);
			}
			if (hierarchy.subtypes.length > 0) {
				lines.push(`Subtypes (${hierarchy.subtypes.length}):`);
				for (const st of hierarchy.subtypes) lines.push(`  - ${st.kind} \`${st.name}\` — ${st.file}:${st.line}`);
			}
			if (hierarchy.implementations.length > 0) {
				lines.push(`Implementations (${hierarchy.implementations.length}):`);
				for (const st of hierarchy.implementations) lines.push(`  - \`${st.file}:${st.line}\``);
			}
			lines.push("");
		}
	}

	const nextItems = getNextForTool("lookup", { topSymbol: matches[0]?.name });
	if (nextItems.length > 0) {
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n").trim();
}

function _executeSymbolJson(graph: RepoGraph, name: string, file?: string): string {
	const matches = _findSymbols(graph, name, file);
	return buildEnvelope(
		"shazam_lookup",
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

// ── Hover info extraction (from hover.ts) ────────────────────────────────

interface HoverInfo {
	lspHover?: string;
	docstring?: string;
	contextLines?: string[];
	signatureHelp?: string;
}

interface AstNode {
	type: string;
	text: string;
	children: AstNode[];
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
}

async function _getHoverInfo(symbol: Symbol): Promise<HoverInfo> {
	const result: HoverInfo = {};
	const lspManager = getLspManager();

	if (lspManager) {
		const serverInfo = await lspManager.getServerForFile(symbol.file);
		if (serverInfo) {
			const client = serverInfo.client;
			try {
				if (!client.isFileOpened(symbol.file)) {
					const content = readFileSync(resolve(serverInfo.workspaceRoot, symbol.file), "utf-8");
					await client.didOpen(symbol.file, content);
				}
				const hoverResult = await client.hover(symbol.file, symbol.line - 1, 0);
				const hoverData = hoverResult.status === "ok" ? hoverResult.data : null;
				if (hoverData?.contents) {
					const contents = hoverData.contents;
					if (typeof contents === "string") {
						result.lspHover = contents;
					} else if (Array.isArray(contents)) {
						result.lspHover = contents
							.map((c: unknown) => {
								if (typeof c === "string") return c;
								if (c && typeof c === "object" && "value" in (c as Record<string, unknown>)) {
									return String((c as Record<string, string>).value);
								}
								return String(c);
							})
							.join("\n\n");
					} else if (contents && typeof contents === "object" && "value" in (contents as Record<string, unknown>)) {
						result.lspHover = String((contents as Record<string, string>).value);
					}
				}
			} catch {
				// LSP hover failed — fall back
			}
		}
	}

	if (!result.lspHover) {
		const filePath = resolve(process.cwd(), symbol.file);
		result.docstring = _extractDocstring(filePath, symbol.line);
		result.contextLines = _extractContextLines(filePath, symbol.line);
	}

	return result;
}

function _extractDocstring(filePath: string, symbolLine: number): string | undefined {
	try {
		const content = readFileSync(filePath, "utf-8");
		const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
		const lang = TreeSitterAdapter.langForExtension(ext);

		if (lang) {
			const tsAdapter = new TreeSitterAdapter(() => {});
			if (tsAdapter.hasLanguage(lang)) {
				const tree = tsAdapter.parse(content, lang);
				if (tree) {
					try {
						const rootNode = tree.rootNode as unknown as AstNode;
						const docComment = _extractDocstringFromAst(rootNode, symbolLine);
						if (docComment) return docComment;
					} finally {
						(tree as any).delete?.();
					}
				}
			}
		}

		return _extractDocstringTextFallback(content, symbolLine);
	} catch {
		return undefined;
	}
}

function _extractDocstringFromAst(root: AstNode, symbolLine: number): string | undefined {
	const commentNodes: { row: number; text: string; endRow: number }[] = [];

	function walk(n: AstNode): void {
		const row = n.startPosition.row + 1;
		const endRow = n.endPosition.row + 1;
		if (n.type === "comment") commentNodes.push({ row, text: n.text, endRow });
		if (n.children && n.children.length > 0) {
			for (const child of n.children) walk(child);
		}
	}

	walk(root);

	let bestComment: string | undefined;
	for (const c of commentNodes) {
		if (c.endRow >= symbolLine - 1 && c.endRow < symbolLine) bestComment = c.text;
	}

	if (bestComment) {
		return bestComment
			.replace(/^\/\*\*?\s?/, "")
			.replace(/\s*\*\/\s*$/, "")
			.split("\n")
			.map((l) => l.replace(/^\s*\*\s?/, ""))
			.filter((l) => l.length > 0)
			.join("\n");
	}
	return undefined;
}

function _extractDocstringTextFallback(content: string, symbolLine: number): string | undefined {
	const lines = content.split("\n");
	const lineIdx = symbolLine - 1;
	const docLines: string[] = [];
	let i = lineIdx - 1;

	while (i >= 0 && lines[i]?.trim() === "") i--;

	if (i >= 0 && lines[i]?.trim().endsWith("*/")) {
		while (i >= 0) {
			const line = lines[i]!;
			docLines.unshift(line);
			if (line.trim().startsWith("/**")) break;
			i--;
		}
		if (docLines.length > 0) {
			return docLines
				.map((l) =>
					l
						.replace(/^\s*\/\*\*?\s?/, "")
						.replace(/\s*\*\/\s*$/, "")
						.replace(/^\s*\*\s?/, ""),
				)
				.filter((l) => l.length > 0)
				.join("\n");
		}
	}

	if (i >= 0 && lines[i]?.trim().startsWith("//")) {
		while (i >= 0 && lines[i]?.trim().startsWith("//")) {
			docLines.unshift(lines[i]!.trim().replace(/^\/\/\s?/, ""));
			i--;
		}
		return docLines.join("\n");
	}

	return undefined;
}

function _extractContextLines(filePath: string, symbolLine: number, contextSize: number = 5): string[] | undefined {
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		const lineIdx = symbolLine - 1;
		const start = Math.max(0, lineIdx);
		const end = Math.min(lines.length, lineIdx + contextSize);
		const context: string[] = [];
		for (let i = start; i < end; i++) {
			context.push(`L${i + 1}: ${lines[i] || ""}`);
		}
		return context;
	} catch {
		return undefined;
	}
}

// ── Type hierarchy (from type_hierarchy.ts) ──────────────────────────────

interface TypeHierarchyEntry {
	name: string;
	kind: string;
	file: string;
	line: number;
	signature: string;
}

interface TypeHierarchyResult {
	symbol: TypeHierarchyEntry;
	supertypes: TypeHierarchyEntry[];
	subtypes: TypeHierarchyEntry[];
	implementations: TypeHierarchyEntry[];
}

async function _getTypeHierarchy(
	graph: RepoGraph,
	symbol: Symbol,
	direction: "both" | "supertypes" | "subtypes" = "both",
): Promise<TypeHierarchyResult> {
	const result: TypeHierarchyResult = {
		symbol: {
			name: symbol.name,
			kind: symbol.kind,
			file: symbol.file,
			line: symbol.line,
			signature: symbol.signature || "",
		},
		supertypes: [],
		subtypes: [],
		implementations: [],
	};

	const lspManager = getLspManager();
	if (lspManager) {
		const serverInfo = await lspManager.getServerForFile(symbol.file);
		if (serverInfo) {
			const client = serverInfo.client;
			try {
				if (!client.isFileOpened(symbol.file)) {
					const content = readFileSync(resolve(serverInfo.workspaceRoot, symbol.file), "utf-8");
					await client.didOpen(symbol.file, content);
				}
				const uri = `file://${resolve(serverInfo.workspaceRoot, symbol.file)}`;
				const position = { line: symbol.line - 1, character: symbol.col || 0 };
				const prepareResult = await client.request("textDocument/prepareTypeHierarchy", {
					textDocument: { uri },
					position,
				});

				if (prepareResult && Array.isArray(prepareResult) && prepareResult.length > 0) {
					const item = prepareResult[0] as Record<string, unknown>;

					if (direction === "both" || direction === "supertypes") {
						const supertypes = (await client.request("typeHierarchy/supertypes", { item })) as Array<
							Record<string, unknown>
						>;
						if (Array.isArray(supertypes)) {
							for (const st of supertypes) {
								result.supertypes.push({
									name: (st.name as string) || "",
									kind: (st.kind as string) || "unknown",
									file: uriToPath((st.uri as string) || "") || "",
									line: ((st.range as Record<string, unknown>)?.start as Record<string, number>)?.line + 1 || 0,
									signature: (st.detail as string) || "",
								});
							}
						}
					}

					if (direction === "both" || direction === "subtypes") {
						const subtypes = (await client.request("typeHierarchy/subtypes", { item })) as Array<
							Record<string, unknown>
						>;
						if (Array.isArray(subtypes)) {
							for (const st of subtypes) {
								result.subtypes.push({
									name: (st.name as string) || "",
									kind: (st.kind as string) || "unknown",
									file: uriToPath((st.uri as string) || "") || "",
									line: ((st.range as Record<string, unknown>)?.start as Record<string, number>)?.line + 1 || 0,
									signature: (st.detail as string) || "",
								});
							}
						}
					}
				}
			} catch {
				// Fall through to graph-based
			}

			// Fetch implementations for interface/trait types
			if (["interface", "type_alias"].includes(symbol.kind)) {
				try {
					const implLocs = await lspImplementation(lspManager, symbol.file, symbol.line - 1, symbol.col || 0);
					if (implLocs && implLocs.length > 0) {
						for (const loc of implLocs) {
							result.implementations.push({
								name: "",
								kind: "implementation",
								file: uriToPath(loc.uri),
								line: loc.range.start.line + 1,
								signature: "",
							});
						}
					}
				} catch {
					// implementation lookup failed — silent
				}
			}
		}
	}

	// Graph-based hierarchy fallback
	const inheritanceKinds = new Set(["class", "interface", "type_alias"]);

	if (direction === "both" || direction === "supertypes") {
		const outgoing = graph.outgoing.get(symbol.id);
		if (outgoing) {
			for (const edge of outgoing) {
				const tgt = graph.symbols.get(edge.target);
				if (tgt && inheritanceKinds.has(tgt.kind)) {
					result.supertypes.push({
						name: tgt.name,
						kind: tgt.kind,
						file: tgt.file,
						line: tgt.line,
						signature: tgt.signature || "",
					});
				}
			}
		}
	}

	if (direction === "both" || direction === "subtypes") {
		const incoming = graph.incoming.get(symbol.id);
		if (incoming) {
			for (const edge of incoming) {
				const src = graph.symbols.get(edge.source);
				if (src && inheritanceKinds.has(src.kind)) {
					result.subtypes.push({
						name: src.name,
						kind: src.kind,
						file: src.file,
						line: src.line,
						signature: src.signature || "",
					});
				}
			}
		}
	}

	result.supertypes = _deduplicateHierarchy(result.supertypes);
	result.subtypes = _deduplicateHierarchy(result.subtypes);

	return result;
}

function _deduplicateHierarchy(entries: TypeHierarchyEntry[]): TypeHierarchyEntry[] {
	const seen = new Set<string>();
	return entries.filter((e) => {
		const key = `${e.name}:${e.file}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// ── File detail (from file_detail.ts) ────────────────────────────────────

async function _executeFileDetailAsync(
	graph: RepoGraph,
	file: string,
	_json: boolean,
	_maxTokens: number | undefined,
): Promise<string> {
	const cacheKey = `${file}:text`;
	const cached = fileDetailCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		try {
			const st = statSync(file);
			if (st.mtimeMs === cached.mtimeMs) return cached.text;
			fileDetailCache.delete(cacheKey);
		} catch {
			return cached.text;
		}
	}

	const baseText = _executeFileDetail(graph, file);
	const lspManager = getLspManager();

	const [lspSymbols, codeLens] = await Promise.all([
		lspDocumentSymbols(lspManager, file, 5000),
		lspCodeLens(lspManager, file, 5000),
	]);

	let text = baseText;
	if (Array.isArray(lspSymbols) && lspSymbols.length > 0 && _isDocumentSymbols(lspSymbols)) {
		const hierarchy = _formatHierarchy(lspSymbols, 0).join("\n");
		const nextIdx = text.indexOf("\n### Next");
		const section = `\n### Symbol Hierarchy (LSP enriched)\n\n${hierarchy}\n`;
		if (nextIdx >= 0) {
			text = text.slice(0, nextIdx) + section + text.slice(nextIdx);
		} else {
			text = text + "\n" + section;
		}
	}

	if (codeLens && codeLens.length > 0) {
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

	let mtimeMs = 0;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		// File may not exist
	}
	if (fileDetailCache.size >= MAX_DETAIL_CACHE_SIZE) {
		const firstKey = fileDetailCache.keys().next().value;
		if (firstKey !== undefined) fileDetailCache.delete(firstKey);
	}
	fileDetailCache.set(cacheKey, { text, timestamp: Date.now(), mtimeMs });

	return text;
}

function _isDocumentSymbols(
	syms: DocumentSymbol[] | import("vscode-languageserver-protocol").SymbolInformation[],
): syms is DocumentSymbol[] {
	return syms.length > 0 && "range" in syms[0]! && "children" in syms[0]!;
}

function _formatHierarchy(syms: DocumentSymbol[], depth: number): string[] {
	const out: string[] = [];
	const indent = "  ".repeat(depth);
	for (const s of syms) {
		if (depth > 0 && LOCAL_KINDS.has(s.kind)) continue;
		const startLine = s.range.start.line + 1;
		const endLine = s.range.end.line + 1;
		out.push(`${indent}- \`${s.name}\` L${startLine}-${endLine}`);
		if (s.children && s.children.length > 0) {
			out.push(..._formatHierarchy(s.children, depth + 1));
		}
	}
	return out;
}

function _executeFileDetail(graph: RepoGraph, file: string): string {
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

	lines.push("### Symbols");
	lines.push("");

	const CONTAINER_KINDS = new Set(["class", "interface", "struct", "impl", "module", "namespace", "object"]);
	const containers: { sym: (typeof symbols)[0]; members: typeof symbols }[] = [];
	const standalone: typeof symbols = [];

	for (const sym of symbols) {
		if (CONTAINER_KINDS.has(sym.kind)) {
			const members = symbols.filter((other) => {
				if (other.id === sym.id) return false;
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

	if (containers.length > 0) {
		for (const { sym, members } of containers) {
			const inc = graph.incoming.get(sym.id);
			const out = graph.outgoing.get(sym.id);
			lines.push(
				`- container ${sym.kind} \`${sym.name}\` L${sym.line}-${sym.endLine} | in:${inc ? inc.length : 0} out:${out ? out.length : 0}`,
			);
			for (const member of members) {
				const mInc = graph.incoming.get(member.id);
				const mOut = graph.outgoing.get(member.id);
				lines.push(
					`  └ ${member.kind} \`${member.name}\` L${member.line}-${member.endLine} [${member.visibility}] PR ${member.pagerank.toFixed(3)} | in:${mInc ? mInc.length : 0} out:${mOut ? mOut.length : 0}`,
				);
			}
		}
		const memberIds = new Set(containers.flatMap(({ members }) => members.map((m) => m.id)));
		const filteredStandalone = standalone.filter((sym) => !memberIds.has(sym.id));
		if (filteredStandalone.length > 0) {
			lines.push("");
			lines.push("Other symbols:");
			for (const sym of filteredStandalone) {
				const inc = graph.incoming.get(sym.id);
				const out = graph.outgoing.get(sym.id);
				lines.push(
					`  - ${sym.kind} \`${sym.name}\` L${sym.line}-${sym.endLine} [${sym.visibility}] PR ${sym.pagerank.toFixed(3)} | in:${inc ? inc.length : 0} out:${out ? out.length : 0}`,
				);
			}
		}
	} else {
		for (const sym of symbols) {
			const inc = graph.incoming.get(sym.id);
			const out = graph.outgoing.get(sym.id);
			lines.push(
				`- ${sym.kind} \`${sym.name}\` L${sym.line}-${sym.endLine} [${sym.visibility}] PR ${sym.pagerank.toFixed(3)} | in:${inc ? inc.length : 0} out:${out ? out.length : 0}`,
			);
			if (sym.signature) lines.push(`  ${sym.signature.slice(0, 100)}`);
		}
	}

	const fileImports = graph.fileImports.get(file);
	if (fileImports && fileImports.length > 0) {
		lines.push("");
		lines.push("### Imports");
		for (const imp of fileImports.slice(0, 20)) lines.push(`- ${imp}`);
	}

	const nextItems = getNextForTool("lookup", { topFile: file, topSymbol: symbols[0]?.name });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

function _executeFileDetailJson(graph: RepoGraph, file: string): string {
	const symIds = graph.fileSymbols.get(file) || [];
	const symbols = symIds.map((id) => graph.symbols.get(id)).filter((s): s is NonNullable<typeof s> => s !== undefined);

	return buildEnvelope("shazam_lookup", process.cwd(), "ok", {
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

// ── State map (from symbol.ts) ───────────────────────────────────────────

function _executeStateMap(graph: RepoGraph, symbolName: string): string {
	const targets: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === symbolName) targets.push(sym);
	}

	if (targets.length === 0) return `Symbol not found: ${symbolName}`;

	const lines: string[] = [];
	for (const target of targets) {
		if (!STATE_MAP_KINDS.has(target.kind)) {
			lines.push(`## ${target.kind} \`${target.name}\` — cannot generate state map`);
			lines.push("");
			lines.push(`Symbol \`${target.name}\` is a ${target.kind}, not an enum, const group, or state machine.`);
			lines.push("State map analysis requires: enum, class, interface, type_alias, or const.");
			lines.push("");
			lines.push(`Use \`shazam_lookup --name ${target.name}\` instead.`);
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
				if (sym) lines.push(`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line}`);
			}
		}

		lines.push("");
		lines.push(`Visibility: ${target.visibility}`);
		lines.push(`PageRank: ${target.pagerank.toFixed(4)}`);
		lines.push(`Signature: ${target.signature}`);
	}

	const nextItems = getNextForTool("lookup", { usageFile: targets[0]?.file });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

// ── Backward-compatible exports (for tests) ─────────────────────────────

export function executeSymbol(graph: RepoGraph, name: string, file?: string): string {
	const matches = _findSymbols(graph, name, file);
	const lines: string[] = [`## Symbol: \`${name}\` (${matches.length} matches) (tree-sitter only)`, ""];
	for (const s of matches) {
		lines.push(`${s.kind} \`${s.name}\` — ${s.file}:${s.line}-${s.endLine} [${s.visibility}]`);
		lines.push(`  PageRank: ${s.pagerank.toFixed(4)}`);
		lines.push(`  signature: ${s.signature}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

export function executeSymbolWithMode(graph: RepoGraph, name: string, mode?: string, file?: string): string {
	if (mode === "state") return _executeStateMap(graph, name);
	return executeSymbol(graph, name, file);
}

export function executeSymbolJson(graph: RepoGraph, name: string, file?: string): string {
	return _executeSymbolJson(graph, name, file);
}

export function executeStateMap(graph: RepoGraph, symbolName: string): string {
	return _executeStateMap(graph, symbolName);
}

export function executeFileDetail(graph: RepoGraph, file: string): string {
	return _executeFileDetail(graph, file);
}

export function executeFileDetailJson(graph: RepoGraph, file: string): string {
	return _executeFileDetailJson(graph, file);
}

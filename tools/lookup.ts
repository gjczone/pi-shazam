/**
 * pi-shazam tools/lookup -- Unified symbol/file lookup tool.
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
import { getEffectiveRoot } from "../core/scanner.js";
import { getNextForTool, formatNextSection, truncateOutput, _logWarn } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { lspDocumentSymbols, lspCodeLens, lspImplementation, ensureFileOpened } from "./lsp_enrich.js";
import type { DocumentSymbol } from "vscode-languageserver-protocol";
import { createTool, buildEnvelope, validatePathInProject } from "./_factory.js";
import { dispatchLookup } from "./_dispatchers.js";
import { setLastToolTiming } from "./_context.js";
import { statSync } from "node:fs";
import { readFileAdaptive } from "../core/encoding.js";
import { resolve } from "node:path";
import { TreeSitterAdapter } from "../core/treesitter.js";
import { uriToPath, pathToUri } from "../lsp/client.js";

// -- Markdown sanitization ------------------------------------------------

/**
 * Escape backticks in user-controlled content to prevent markdown injection.
 * Symbol names and docstrings may contain backtick characters that would
 * break markdown formatting when interpolated into tool output.
 */
function _sanitizeMarkdown(s: string): string {
	// Escape backslashes first, then backticks, to prevent markdown injection
	// when input contains a pre-escaped backtick (e.g., \` becomes \\` which
	// renders as ` in markdown).
	return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

// -- State map kinds (from symbol.ts) -------------------------------------

const STATE_MAP_KINDS = new Set(["enum", "class", "interface", "type_alias", "const"]);

// -- File detail cache (from file_detail.ts) -----------------------------

const MAX_DETAIL_CACHE_SIZE = 200;
const fileDetailCache = new Map<string, { text: string; timestamp: number; mtimeMs: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// LRU access-order tracking (issue #368): Map insertion order provides O(1) LRU.
// Map keys are ordered by insertion time; deleting and re-inserting moves a key
// to the "most recently used" end. The first key yielded by keys() is the LRU.
const _detailAccessOrder = new Map<string, true>();

/** Remove a key from both the cache and the access-order tracking. */
function _removeFromDetailCache(key: string): void {
	fileDetailCache.delete(key);
	_detailAccessOrder.delete(key);
}

// -- LSP SymbolKind constants ---------------------------------------------

const LOCAL_KINDS = new Set([13, 14]);

// -- Registration ---------------------------------------------------------

export function registerLookup(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_lookup",
		label: "Lookup Symbol or File",
		description: `\
		Look up anything in the codebase - a symbol by name or a file by path.
		Auto-detects whether the input is a file path or symbol name and returns
		the most relevant information: definition, kind, signature, type hierarchy,
		file structure, PageRank, callers/callees. Use mode=state for enum/state
		analysis. Use mode=search for fuzzy concept search, or just ask in natural language (auto-detected).
		Pass showCallbacks=true to expand anonymous functions.`,
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
			const maxTokens = params.maxTokens as number | undefined;
			const name = typeof params.name === "string" ? params.name : "";
			if (!name) {
				return { content: [{ type: "text", text: "Error: name parameter is required" }] };
			}

			const tScan = Date.now();
			const graph = scanProject(".");
			const scanMs = Date.now() - tScan;
			const laps: Record<string, number> = { scanProject: scanMs };

			const projectRoot = getEffectiveRoot();
			const result = await dispatchLookup(graph, params, projectRoot);
			let text = result.text;
			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens);
			}
			laps.formatOutput = Date.now() - tScan - Object.values(laps).reduce((a, b) => a + b, 0);
			setLastToolTiming(laps);
			return { content: [{ type: "text", text }], isError: result.isError };
		},
	});
}

// -- Dispatch helper ------------------------------------------------------

// _isFilePath moved to tools/_dispatchers.ts (shared between Pi and MCP).

// -- Symbol lookup (from symbol.ts + hover.ts + type_hierarchy.ts) --------

interface EnrichedMatch {
	sym: Symbol;
	container: string | null;
	endLine: number;
	source: "lsp" | "tree-sitter";
}

export function _findSymbols(graph: RepoGraph, name: string, file?: string): Symbol[] {
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
		return `Symbol not found: \`${_sanitizeMarkdown(name)}\`.\n\nCheck spelling, or use \`shazam_overview\` to browse the project structure.`;
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
		`## Lookup: \`${_sanitizeMarkdown(name)}\` (${namedMatches.length} matches${collapsedCount > 0 ? `, ${collapsedCount} anonymous collapsed` : ""})${sourceLabel}`,
	);
	lines.push("");

	// Hover info -- fetch in parallel for all matches
	const hoverResults = await Promise.all(namedMatches.map((e) => _getHoverInfo(e.sym)));

	for (let i = 0; i < namedMatches.length; i++) {
		const e = namedMatches[i]!;
		const s = e.sym;
		lines.push(`${s.kind} \`${_sanitizeMarkdown(s.name)}\` - ${s.file}:${s.line}-${e.endLine} [${s.visibility}]`);
		if (e.container) lines.push(`  container: ${e.container}`);
		lines.push(`  PageRank: ${s.pagerank.toFixed(4)}`);
		lines.push(`  signature: ${s.signature}`);

		// Hover info (inline, from hover.ts)
		const hoverInfo = hoverResults[i]!;
		if (hoverInfo.lspHover) {
			lines.push(`  hover: ${_sanitizeMarkdown(hoverInfo.lspHover.split("\n")[0]!.slice(0, 120))}`);
		} else if (hoverInfo.docstring) {
			lines.push(`  docs: ${_sanitizeMarkdown(hoverInfo.docstring.split("\n")[0]!.slice(0, 120))}`);
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
				for (const st of hierarchy.supertypes)
					lines.push(`  - ${st.kind} \`${_sanitizeMarkdown(st.name)}\` - ${st.file}:${st.line}`);
			}
			if (hierarchy.subtypes.length > 0) {
				lines.push(`Subtypes (${hierarchy.subtypes.length}):`);
				for (const st of hierarchy.subtypes)
					lines.push(`  - ${st.kind} \`${_sanitizeMarkdown(st.name)}\` - ${st.file}:${st.line}`);
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

export function _executeSymbolJson(graph: RepoGraph, name: string, file?: string): string {
	const matches = _findSymbols(graph, name, file);
	return buildEnvelope(
		"shazam_lookup",
		getEffectiveRoot(),
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

// -- Hover info extraction (from hover.ts) --------------------------------

interface HoverInfo {
	lspHover?: string;
	docstring?: string;
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
		try {
			const ctx = lspManager;
			const opened = await ensureFileOpened(ctx, symbol.file);
			if (opened) {
				const hoverResult = await opened.client.hover(symbol.file, symbol.line - 1, 0);
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
			}
		} catch (err) {
			_logWarn("_getHoverInfo", "LSP hover failed", err);
			// LSP hover failed -- fall back to tree-sitter docstring
		}
	}

	if (!result.lspHover) {
		const filePath = resolve(getEffectiveRoot(), symbol.file);
		result.docstring = _extractDocstring(filePath, symbol.line);
	}

	return result;
}

// Module-scoped lazy singleton: avoids loading all grammars on every _extractDocstring call
let _docstringAdapter: TreeSitterAdapter | null = null;
function getDocstringAdapter(): TreeSitterAdapter {
	if (!_docstringAdapter) {
		_docstringAdapter = new TreeSitterAdapter(() => {});
	}
	return _docstringAdapter;
}

// Per-file docstring cache: keyed by filePath + mtime, stores parsed comment
// nodes so that multiple symbol lookups in the same file reuse one parse.
// Avoids N× read+parse for N symbols in a single file.
interface DocstringCacheEntry {
	mtime: number;
	comments: { row: number; text: string; endRow: number }[];
}
const _docstringCache = new Map<string, DocstringCacheEntry>();

function _extractDocstring(filePath: string, symbolLine: number): string | undefined {
	try {
		let mtime: number;
		try {
			mtime = statSync(filePath).mtimeMs;
		} catch (_e) {
			mtime = 0;
		}

		const cacheKey = `${filePath}::${mtime}`;
		const cached = _docstringCache.get(cacheKey);
		if (cached) {
			return _findCommentForLine(cached.comments, symbolLine);
		}

		const content = readFileAdaptive(filePath);
		const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
		const lang = TreeSitterAdapter.langForExtension(ext);

		let comments: { row: number; text: string; endRow: number }[] | null = null;

		if (lang) {
			const tsAdapter = getDocstringAdapter();
			if (tsAdapter.hasLanguage(lang)) {
				const tree = tsAdapter.parse(content, lang);
				if (tree) {
					try {
						const rootNode = tree.rootNode as AstNode;
						comments = _collectCommentNodes(rootNode);
					} finally {
						tree.delete?.();
					}
				}
			}
		}

		// Populate cache before falling back to text search, so subsequent
		// calls for the same file reuse the cached comment nodes.
		if (!comments) comments = [];
		_docstringCache.set(cacheKey, { mtime, comments });

		const astResult = _findCommentForLine(comments, symbolLine);
		if (astResult) return astResult;

		return _extractDocstringTextFallback(content, symbolLine);
	} catch (err) {
		_logWarn("_extractDocstring", "docstring extraction failed", err);
		return undefined;
	}
}

function _collectCommentNodes(root: AstNode): { row: number; text: string; endRow: number }[] {
	const nodes: { row: number; text: string; endRow: number }[] = [];
	function walk(n: AstNode): void {
		const row = n.startPosition.row + 1;
		const endRow = n.endPosition.row + 1;
		if (n.type === "comment") nodes.push({ row, text: n.text, endRow });
		if (n.children && n.children.length > 0) {
			for (const child of n.children) walk(child);
		}
	}
	walk(root);
	return nodes;
}

function _findCommentForLine(
	comments: { row: number; text: string; endRow: number }[],
	symbolLine: number,
): string | undefined {
	let bestComment: string | undefined;
	for (const c of comments) {
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

// -- Type hierarchy (from type_hierarchy.ts) ------------------------------

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
			const filePath = resolve(serverInfo.workspaceRoot, symbol.file);
			const uri = pathToUri(filePath);
			const position = { line: symbol.line - 1, character: symbol.col || 0 };

			// Open file if needed (shared across all hierarchy requests)
			try {
				if (!client.isFileOpened(symbol.file)) {
					const fileContent = readFileAdaptive(filePath);
					await client.didOpen(symbol.file, fileContent);
				}
			} catch (err) {
				_logWarn("_getTypeHierarchy", "file open failed", err);
				// File open failed -- skip LSP hierarchy
			}

			// Step 1: prepareTypeHierarchy (separate error handling)
			let prepareResult: unknown = null;
			try {
				prepareResult = await client.request("textDocument/prepareTypeHierarchy", {
					textDocument: { uri },
					position,
				});
			} catch (err) {
				_logWarn("_getTypeHierarchy", "prepareTypeHierarchy not supported", err);
				// prepareTypeHierarchy not supported by server
			}

			if (prepareResult && Array.isArray(prepareResult) && prepareResult.length > 0) {
				const item = prepareResult[0] as Record<string, unknown>;

				// Step 2: fetch supertypes and subtypes in parallel (independent LSP requests)
				const needSuper = direction === "both" || direction === "supertypes";
				const needSub = direction === "both" || direction === "subtypes";

				const [superResult, subResult] = await Promise.all([
					needSuper
						? client.request("typeHierarchy/supertypes", { item }).catch((err) => {
								_logWarn("_getTypeHierarchy", "supertypes request failed", err);
								return null;
							})
						: Promise.resolve(null),
					needSub
						? client.request("typeHierarchy/subtypes", { item }).catch((err) => {
								_logWarn("_getTypeHierarchy", "subtypes request failed", err);
								return null;
							})
						: Promise.resolve(null),
				]);

				if (needSuper && Array.isArray(superResult)) {
					for (const st of superResult as Array<Record<string, unknown>>) {
						result.supertypes.push({
							name: (st.name as string) || "",
							kind: (st.kind as string) || "unknown",
							file: uriToPath((st.uri as string) || "") || "",
							line: ((st.range as Record<string, unknown>)?.start as Record<string, number>)?.line + 1 || 0,
							signature: (st.detail as string) || "",
						});
					}
				}

				if (needSub && Array.isArray(subResult)) {
					for (const st of subResult as Array<Record<string, unknown>>) {
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
				} catch (err) {
					_logWarn("_getTypeHierarchy", "implementation lookup failed", err);
					// implementation lookup failed -- silent
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

// -- File detail (from file_detail.ts) ------------------------------------

async function _executeFileDetailAsync(
	graph: RepoGraph,
	file: string,
	_json: boolean,
	_maxTokens: number | undefined,
): Promise<string> {
	// Defense-in-depth: reject paths outside project root (issue #395)
	if (!validatePathInProject(file, getEffectiveRoot())) {
		return `Error: Path '${file}' is outside the project root and cannot be read.`;
	}
	const cacheKey = `${file}:text`;
	const cached = fileDetailCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		try {
			const st = statSync(resolve(getEffectiveRoot(), file));
			if (st.mtimeMs === cached.mtimeMs) {
				// LRU: move current key to the "most recently used" end
				_detailAccessOrder.delete(cacheKey);
				_detailAccessOrder.set(cacheKey, true);
				return cached.text;
			}
			_removeFromDetailCache(cacheKey);
		} catch (err) {
			_logWarn("_executeFileDetailAsync", "stat failed for cache entry, returning stale content", err);
			return `[STALE CACHE WARNING] File '${file}' is no longer accessible (stat failed). The content below may be outdated.\n\n${cached.text}`;
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
		mtimeMs = statSync(resolve(getEffectiveRoot(), file)).mtimeMs;
	} catch (err) {
		_logWarn("_executeFileDetailAsync", `stat failed for ${file}`, err);
		// File may not exist
	}
	if (fileDetailCache.size >= MAX_DETAIL_CACHE_SIZE) {
		// LRU: evict the first key (least recently accessed, earliest inserted)
		const lruKey = _detailAccessOrder.keys().next().value;
		if (lruKey !== undefined) {
			_detailAccessOrder.delete(lruKey);
			fileDetailCache.delete(lruKey);
		}
	}
	fileDetailCache.set(cacheKey, { text, timestamp: Date.now(), mtimeMs });
	// LRU: insert new key at the "most recently used" end
	_detailAccessOrder.set(cacheKey, true);

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
		out.push(`${indent}- \`${_sanitizeMarkdown(s.name)}\` L${startLine}-${endLine}`);
		if (s.children && s.children.length > 0) {
			out.push(..._formatHierarchy(s.children, depth + 1));
		}
	}
	return out;
}

export function _executeFileDetail(graph: RepoGraph, file: string): string {
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

	// O(N log N) stack-based single-pass traversal (was O(N²) filter).
	// Pre-sort: by line ascending, same line by endLine descending (outer container first), then col ascending for stability.
	const sorted = [...symbols].sort((a, b) => a.line - b.line || b.endLine - a.endLine || a.col - b.col);
	const containerMap = new Map<string, { sym: (typeof symbols)[0]; members: typeof symbols }>();
	const stack: (typeof symbols)[0][] = [];

	for (const sym of sorted) {
		// Symbol start line exceeds top-of-stack container end line -> pop closed containers.
		while (stack.length > 0 && sym.line > stack[stack.length - 1].endLine) {
			stack.pop();
		}

		if (CONTAINER_KINDS.has(sym.kind)) {
			const entry = { sym, members: [] as typeof symbols };
			containerMap.set(sym.id, entry);
			// Flat containment: this container is a member of all parent containers on the stack.
			for (const parent of stack) {
				containerMap.get(parent.id)!.members.push(sym);
			}
			stack.push(sym);
		} else {
			// Non-container symbol: belongs to all parent containers on the stack.
			for (const parent of stack) {
				containerMap.get(parent.id)!.members.push(sym);
			}
			if (stack.length === 0) {
				standalone.push(sym);
			}
		}
	}

	// Containers with members keep container display; containers without members are demoted to standalone symbols.
	for (const entry of containerMap.values()) {
		if (entry.members.length > 0) {
			containers.push(entry);
		} else {
			standalone.push(entry.sym);
		}
	}

	if (containers.length > 0) {
		for (const { sym, members } of containers) {
			const inc = graph.incoming.get(sym.id);
			const out = graph.outgoing.get(sym.id);
			lines.push(
				`- container ${sym.kind} \`${_sanitizeMarkdown(sym.name)}\` L${sym.line}-${sym.endLine} | in:${inc ? inc.length : 0} out:${out ? out.length : 0}`,
			);
			for (const member of members) {
				const mInc = graph.incoming.get(member.id);
				const mOut = graph.outgoing.get(member.id);
				lines.push(
					`  - ${member.kind} \`${_sanitizeMarkdown(member.name)}\` L${member.line}-${member.endLine} [${member.visibility}] PR ${member.pagerank.toFixed(4)} | in:${mInc ? mInc.length : 0} out:${mOut ? mOut.length : 0}`,
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
					`  - ${sym.kind} \`${_sanitizeMarkdown(sym.name)}\` L${sym.line}-${sym.endLine} [${sym.visibility}] PR ${sym.pagerank.toFixed(4)} | in:${inc ? inc.length : 0} out:${out ? out.length : 0}`,
				);
			}
		}
	} else {
		for (const sym of symbols) {
			const inc = graph.incoming.get(sym.id);
			const out = graph.outgoing.get(sym.id);
			lines.push(
				`- ${sym.kind} \`${_sanitizeMarkdown(sym.name)}\` L${sym.line}-${sym.endLine} [${sym.visibility}] PR ${sym.pagerank.toFixed(4)} | in:${inc ? inc.length : 0} out:${out ? out.length : 0}`,
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

	return buildEnvelope("shazam_lookup", getEffectiveRoot(), "ok", {
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

/**
 * Detect whether a query string looks like natural language (concept search)
 * rather than a symbol name. Used for auto-fallback: when symbol lookup returns
 * 0 results and the input looks like NL, automatically switch to search mode.
 *
 * Heuristics:
 *   - Contains whitespace (multi-word) -> natural language
 *   - Contains question words (how, what, where, why, who, when, which)
 *   - Starts with lowercase letter followed by lowercase (not CamelCase)
 */
export function _looksLikeNaturalLanguage(query: string): boolean {
	const trimmed = query.trim();
	if (!trimmed) return false;

	// Multi-word with spaces -> natural language
	if (/\s/.test(trimmed)) return true;

	// Contains question-like patterns
	if (/^(how|what|where|why|who|when|which)/i.test(trimmed)) return true;

	// All lowercase with no obvious code patterns (no dots, parens, underscores)
	// and longer than a typical symbol name prefix
	if (/^[a-z][a-z0-9 ]{10,}$/.test(trimmed) && !/[._($]/.test(trimmed)) return true;

	return false;
}

// -- Concept search (#490) -------------------------------------------------

interface SearchResult {
	sym: Symbol;
	score: number;
}

/**
 * Execute a fuzzy concept search across the full symbol metadata corpus.
 *
 * Algorithm: token-overlap scoring weighted by PageRank.
 * For each symbol, builds a searchable text corpus from name, kind, signature,
 * and docstring (all lowercased). Scores each symbol by (matchedTokens / totalTokens)
 * multiplied by (1 + pagerank) to surface high-impact matches first.
 *
 * This beats raw grep by matching semantic concepts (e.g., "authentication"
 * matches symbols named "authenticate", "login", "verifyCredentials") based
 * on the existing symbol metadata across all languages.
 */
export function _executeSearch(graph: RepoGraph, query: string): SearchResult[] {
	if (!query || query.trim().length === 0) return [];

	const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (queryTokens.length === 0) return [];

	const results: SearchResult[] = [];

	for (const sym of graph.symbols.values()) {
		// Build searchable text corpus
		const corpus = [sym.name, sym.kind, sym.signature, sym.docstring].filter(Boolean).join(" ").toLowerCase();

		// Count how many query tokens appear in the corpus
		let matchCount = 0;
		for (const token of queryTokens) {
			if (corpus.includes(token)) matchCount++;
		}

		if (matchCount > 0) {
			const tokenRatio = matchCount / queryTokens.length;
			const score = tokenRatio * (1 + sym.pagerank);
			results.push({ sym, score });
		}
	}

	// Sort by score descending, take top 15
	return results.sort((a, b) => b.score - a.score).slice(0, 15);
}

/**
 * Format search results as readable text output.
 */
export function _formatSearchResults(query: string, results: SearchResult[]): string {
	const lines: string[] = [];
	lines.push(`## Concept Search: \`${_sanitizeMarkdown(query)}\` — ${results.length} results`);
	lines.push("");

	if (results.length === 0) {
		lines.push("No matching symbols found.");
		lines.push("");
		lines.push("Try:");
		lines.push("- Using fewer or different keywords");
		lines.push("- Running \`shazam_overview\` to browse the project structure");
		return lines.join("\n");
	}

	for (let i = 0; i < results.length; i++) {
		const { sym, score } = results[i]!;
		const desc = sym.docstring ? sym.docstring.split(".")[0]!.slice(0, 100) : sym.signature.slice(0, 100);
		lines.push(`${i + 1}. **${_sanitizeMarkdown(sym.name)}** (${sym.kind}) — \`${sym.file}:${sym.line}\``);
		lines.push(`   ${desc || "-"}`);
		lines.push(`   Score: ${score.toFixed(4)}`);
		lines.push("");
	}

	return lines.join("\n").trim();
}

// -- State map (from symbol.ts) -------------------------------------------

export function _executeStateMap(graph: RepoGraph, symbolName: string): string {
	const targets: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === symbolName) targets.push(sym);
	}

	if (targets.length === 0) return `Symbol not found: ${_sanitizeMarkdown(symbolName)}`;

	const lines: string[] = [];
	for (const target of targets) {
		if (!STATE_MAP_KINDS.has(target.kind)) {
			lines.push(`## ${target.kind} \`${_sanitizeMarkdown(target.name)}\` - cannot generate state map`);
			lines.push("");
			lines.push(
				`Symbol \`${_sanitizeMarkdown(target.name)}\` is a ${target.kind}, not an enum, const group, or state machine.`,
			);
			lines.push("State map analysis requires: enum, class, interface, type_alias, or const.");
			lines.push("");
			lines.push(`Use \`shazam_lookup --name ${_sanitizeMarkdown(target.name)}\` instead.`);
			continue;
		}

		lines.push(`## State Map: ${target.kind} \`${_sanitizeMarkdown(target.name)}\` (${target.file}:${target.line})`);
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
				lines.push(`  **${file}**: ${syms.map((s) => _sanitizeMarkdown(s.name)).join(", ")}`);
			}
		}

		if (outgoing.length > 0) {
			lines.push("");
			lines.push(`### Dependencies (${outgoing.length} symbols this depends on)`);
			for (const edge of outgoing) {
				const sym = graph.symbols.get(edge.target);
				if (sym) lines.push(`- ${sym.kind} \`${_sanitizeMarkdown(sym.name)}\` - ${sym.file}:${sym.line}`);
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

export function executeStateMap(graph: RepoGraph, symbolName: string): string {
	return _executeStateMap(graph, symbolName);
}

export function executeFileDetailJson(graph: RepoGraph, file: string): string {
	return _executeFileDetailJson(graph, file);
}

/** Async LSP-enriched symbol lookup for MCP clients. See _executeLookupAsync. */
export async function executeLookupAsync(
	graph: RepoGraph,
	name: string,
	file: string | undefined,
	direction: "both" | "supertypes" | "subtypes",
	showCallbacks: boolean,
): Promise<string> {
	// Defense-in-depth: reject file paths outside project root (issue #395)
	if (file && !validatePathInProject(file, getEffectiveRoot())) {
		return `Error: File path '${file}' is outside the project root.`;
	}
	return _executeLookupAsync(graph, name, file, direction, showCallbacks);
}

/** Async LSP-enriched file detail for MCP clients. See _executeFileDetailAsync. */
export async function executeFileDetailAsync(graph: RepoGraph, file: string): Promise<string> {
	return _executeFileDetailAsync(graph, file, false, undefined);
}

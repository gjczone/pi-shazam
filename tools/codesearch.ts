/**
 * pi-shazam tools/codesearch — BM25 symbol search with optional LSP enrichment.
 *
 * When LSP servers are running and advertise workspaceSymbolProvider,
 * workspace/symbol results are merged with BM25 scores. LSP hits get
 * a +50 score boost so they float to the top. Output is annotated
 * "(LSP enriched)" or "(tree-sitter only)" accordingly.
 */
import { readdirSync, statSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, AgentToolResult } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { isNonSourceFile } from "../core/filter.js";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { lspWorkspaceSearch, type EnrichedSymbolHit } from "./lsp_enrich.js";
import { createTool } from "./_factory.js";
import { buildEnvelope } from "./_factory.js";

const LSP_BOOST = 50;

// ── Stop words for natural language query tokenization ──────────────────
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"can",
	"shall",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"and",
	"but",
	"or",
	"not",
	"no",
	"if",
	"then",
	"else",
	"when",
	"where",
	"why",
	"how",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"only",
	"own",
	"same",
	"so",
	"than",
	"too",
	"very",
	"just",
	"about",
	"also",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"you",
	"he",
	"she",
	"we",
	"they",
	"me",
	"him",
	"her",
	"us",
	"them",
	"my",
	"your",
	"his",
	"our",
	"their",
	"what",
	"which",
	"who",
	"whom",
	"whose",
]);

/** True when query has spaces and >= 2 words (looks like natural language). */
function isNaturalLanguageQuery(query: string): boolean {
	const trimmed = query.trim();
	return trimmed.includes(" ") && trimmed.split(/\s+/).length >= 2;
}

/** Split a NL query into meaningful tokens (min length 2, stop words removed). */
function tokenizeForSearch(query: string): string[] {
	const lower = query.toLowerCase();
	const tokens = lower.split(/[^a-z0-9_]+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
	return [...new Set(tokens)];
}

/** Escape regex special characters in a literal string. */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function registerCodesearch(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_codesearch",
		label: "Code Search (BM25)",
		description: `\
		Don't reach for grep or raw text search across the codebase. Use this
		instead — it ranks results by relevance (BM25), understands
		camelCase/snake_case token boundaries, and enriches hits with LSP
		workspace symbols. Two modes: target="symbol" (default, semantic
		ranking) and target="code" (full-text with context snippets via
		ripgrep).`,
		params: Type.Object({
			query: Type.String(),
			target: Type.Optional(Type.Union([Type.Literal("symbol"), Type.Literal("code")])),
			topN: Type.Optional(Type.Number()),
			mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex"), Type.Literal("smart")])),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const target = params.target ?? "symbol";
			const maxTokens = params.maxTokens;
			const query = typeof params.query === "string" ? params.query : "";
			if (!query) {
				return { content: [{ type: "text", text: "Error: query parameter is required" }] };
			}

			if (target === "code") {
				// Use the extension context's cwd for fulltext search (fixes #251:
				// process.cwd() is wrong in MCP context where the server process
				// cwd differs from the project root).
				const projectRoot = _ctx?.cwd || process.cwd();
				const searchMode = (params.mode as string) ?? "literal";
				const result = executeFulltextSearch(query, params.topN as number | undefined, projectRoot, searchMode);
				let text = json
					? buildEnvelope("shazam_codesearch", projectRoot, "ok", { query, target: "code", results: result.length })
					: formatFulltextResult(result, query);
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
			}

			// BM25 + LSP workspace/symbol in parallel
			const graph = scanProject(".");
			const bm25Results = executeCodesearch(graph, query, params.topN as number | undefined);
			const lspManager = getLspManager();
			const lspResults = await lspWorkspaceSearch(lspManager, query, 5000);
			const merged = mergeResults(graph, bm25Results, lspResults, params.topN as number | undefined);
			const source = lspResults.length > 0 ? "lsp+bm25" : "bm25";

			let text = json
				? JSON.stringify({
						schema_version: "1.0",
						command: "codesearch",
						status: "ok",
						result: {
							query: params.query,
							target: "symbol",
							results: merged.length,
							source,
						},
					})
				: formatCodesearchResult(merged, params.query as string, source);
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

export function executeCodesearch(graph: RepoGraph, query: string, topN?: number): { sym: Symbol; score: number }[] {
	const limit = topN ?? 20;
	const lower = query.toLowerCase();
	const tokens = tokenize(query);

	const scored: { sym: Symbol; score: number }[] = [];

	for (const sym of graph.symbols.values()) {
		// Skip non-source files (config, generated, lockfiles)
		if (isNonSourceFile(sym.file)) continue;

		const nameLower = sym.name.toLowerCase();
		let score = 0;

		// Exact match — highest priority (fixes #108)
		if (nameLower === lower) {
			score += 200;
		}

		// Prefix match (e.g., "verify" matches "executeVerify")
		if (nameLower.startsWith(lower) || nameLower.endsWith(lower)) {
			score += 50;
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

		// PageRank boost (reduced weight to fix #108 — was 50, now 15)
		score += sym.pagerank * 15;

		if (score > 0) {
			scored.push({ sym, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
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

	// Also add the whole query as a token for exact matching
	const wholeQuery = query.toLowerCase().trim();
	if (wholeQuery.length >= 2 && !tokens.includes(wholeQuery)) {
		tokens.push(wholeQuery);
	}

	return tokens;
}

/**
 * Result type covering both BM25 and LSP sources.
 */
interface CodesearchHit {
	sym: Symbol;
	score: number;
	source: "bm25" | "lsp" | "lsp+bm25";
}

/**
 * Merge LSP hits with BM25 hits, deduplicating by file+line+name.
 * LSP hits float to the top (via score boost).
 */
export function mergeResults(
	graph: RepoGraph,
	bm25Results: { sym: Symbol; score: number }[],
	lspHits: EnrichedSymbolHit[],
	topN?: number,
): CodesearchHit[] {
	const limit = topN ?? 20;
	const seen = new Set<string>();
	const out: CodesearchHit[] = [];

	// Build map of BM25 scores by symbol ID
	const bm25ScoreById = new Map<string, number>();
	for (const { sym, score } of bm25Results) {
		bm25ScoreById.set(sym.id, score);
	}

	// LSP hits first
	for (const hit of lspHits) {
		const key = `${hit.file}:${hit.line}:${hit.name}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const graphSym = findGraphSymbol(graph, hit.name, hit.file, hit.line);
		if (graphSym) {
			const base = bm25ScoreById.get(graphSym.id) ?? 0;
			out.push({ sym: graphSym, score: base + LSP_BOOST, source: "lsp+bm25" });
		} else {
			// Synthesize a Symbol from LSP hit
			const synth: Symbol = {
				id: `${hit.file}::${hit.name}::${hit.line}`,
				name: hit.name,
				kind: hit.kind,
				file: hit.file,
				line: hit.line,
				endLine: hit.endLine,
				col: hit.col,
				visibility: "public",
				docstring: "",
				signature: "",
				returnType: "",
				params: "",
				pagerank: 0,
			};
			out.push({ sym: synth, score: LSP_BOOST, source: "lsp" });
		}
	}

	// BM25 hits next, skipping duplicates
	for (const { sym, score } of bm25Results) {
		const key = `${sym.file}:${sym.line}:${sym.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ sym, score, source: "bm25" });
		if (out.length >= limit) break;
	}

	out.sort((a, b) => b.score - a.score);
	return out.slice(0, limit);
}

function findGraphSymbol(graph: RepoGraph, name: string, file: string, line: number): Symbol | undefined {
	const ids = graph.fileSymbols.get(file);
	if (!ids) return undefined;
	for (const id of ids) {
		const sym = graph.symbols.get(id);
		if (sym && sym.name === name && Math.abs(sym.line - line) <= 2) {
			return sym;
		}
	}
	return undefined;
}

function formatCodesearchResult(results: CodesearchHit[], query: string, source: string): string {
	if (results.length === 0) {
		return `No symbols found for query: "${query}"`;
	}

	const sourceLabel = source === "lsp+bm25" ? " (LSP enriched)" : " (tree-sitter only)";
	const lines: string[] = [`## Code Search: "${query}" (${results.length} results)${sourceLabel}`, ""];
	for (let i = 0; i < results.length; i++) {
		const hit = results[i]!;
		const srcTag = hit.source === "lsp" ? " [LSP]" : hit.source === "lsp+bm25" ? " [LSP+BM25]" : "";
		lines.push(
			`${i + 1}. ${hit.sym.kind} \`${hit.sym.name}\`${srcTag} — ${hit.sym.file}:${hit.sym.line} (PR ${hit.sym.pagerank.toFixed(3)})`,
		);
	}

	const nextItems = getNextForTool("codesearch", {
		topSymbol: results[0]?.sym.name,
	});
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

// ── Full-text search (target="code") ────────────────────────────────────────────

interface FulltextMatch {
	file: string;
	line: number;
	column: number;
	text: string;
}

export function executeFulltextSearch(
	query: string,
	topN?: number,
	projectRoot?: string,
	mode?: string,
): FulltextMatch[] {
	const limit = topN ?? 20;
	const root = projectRoot ?? process.cwd();
	const searchMode = mode ?? "literal";

	// regex mode: pass tokenized query directly as regex alternation
	if (searchMode === "regex") {
		const tokens = tokenizeForSearch(query);
		const pattern = tokens.length > 0 ? tokens.map((t) => escapeRegex(t)).join("|") : escapeRegex(query);
		return executeRegexSearch(query, limit, root, pattern);
	}

	// literal or smart: try literal first
	const literalResults = executeLiteralSearch(query, limit, root);

	// smart mode: fall back to tokenized regex when literal yields few results
	if (searchMode === "smart" && literalResults.length < 3 && isNaturalLanguageQuery(query)) {
		const tokens = tokenizeForSearch(query);
		if (tokens.length > 0) {
			const pattern = tokens.map((t) => escapeRegex(t)).join("|");
			const regexResults = executeRegexSearch(query, limit, root, pattern);
			if (regexResults.length > literalResults.length) {
				return regexResults;
			}
		}
	}

	return literalResults;
}

/** Run ripgrep with -F (literal) matching. Extracted from executeFulltextSearch. */
function executeLiteralSearch(query: string, limit: number, projectRoot: string): FulltextMatch[] {
	const rgPath = findRipgrep();
	if (rgPath) {
		try {
			const output = execFileSync(
				rgPath,
				[
					"--no-heading",
					"-n",
					"--max-count",
					"20",
					"--context",
					"1",
					"-i",
					"-F",
					"-g",
					"!.git",
					"-g",
					"!node_modules",
					"-g",
					"!dist",
					"-g",
					"!*.lock",
					"-g",
					"!package-lock.json",
					"-g",
					"!yarn.lock",
					"-g",
					"!pnpm-lock.yaml",
					"--",
					query,
					projectRoot,
				],
				{ encoding: "utf-8", timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
			);
			return parseRipgrepOutput(output, query, limit);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("not found") && !msg.includes("No such file")) {
				console.warn(`[pi-shazam] ripgrep fulltext search failed: ${msg}`);
			}
		}
	}
	return builtinFulltextSearch(query, limit, projectRoot);
}

/** Run ripgrep with -P (PCRE2) regex alternation from tokenized query. */
function executeRegexSearch(query: string, limit: number, projectRoot: string, pattern: string): FulltextMatch[] {
	const rgPath = findRipgrep();
	if (rgPath) {
		try {
			const output = execFileSync(
				rgPath,
				[
					"--no-heading",
					"-n",
					"--max-count",
					"50",
					"-i",
					"-P",
					"-g",
					"!.git",
					"-g",
					"!node_modules",
					"-g",
					"!dist",
					"-g",
					"!*.lock",
					"-g",
					"!package-lock.json",
					"-g",
					"!yarn.lock",
					"-g",
					"!pnpm-lock.yaml",
					"-e",
					pattern,
					projectRoot,
				],
				{ encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
			);
			const parsed = parseRipgrepOutputNoContext(output, query);
			return scoreAndRankRegexResults(parsed, query, limit);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("not found") && !msg.includes("No such file")) {
				console.warn(`[pi-shazam] ripgrep regex search failed: ${msg}`);
			}
			return [];
		}
	}
	return builtinRegexSearch(query, limit, projectRoot, pattern);
}

/** Score results by how many query tokens appear in each line, then rank. */
function scoreAndRankRegexResults(results: FulltextMatch[], query: string, limit: number): FulltextMatch[] {
	const tokens = tokenizeForSearch(query).map((t) => t.toLowerCase());
	if (tokens.length === 0) return results.slice(0, limit);

	const scored = results.map((r) => {
		const lowerText = r.text.toLowerCase();
		let matchCount = 0;
		for (const t of tokens) {
			if (lowerText.includes(t)) matchCount++;
		}
		return { ...r, matchCount };
	});

	scored.sort((a, b) => b.matchCount - a.matchCount);
	return scored.slice(0, limit).map(({ matchCount: _, ...r }) => r);
}

/** Parse rg output without --context (no context lines to skip). */
function parseRipgrepOutputNoContext(output: string, query: string): FulltextMatch[] {
	const results: FulltextMatch[] = [];
	const lines = output.split("\n").filter(Boolean);
	const tokens = tokenizeForSearch(query);

	for (const line of lines) {
		const match = line.match(/^(.+?):(\d+):(.+)/);
		if (match) {
			const text = match[3]!;
			let col = 1;
			const lowerText = text.toLowerCase();
			for (const t of tokens) {
				const idx = lowerText.indexOf(t.toLowerCase());
				if (idx !== -1) {
					col = idx + 1;
					break;
				}
			}
			if (col === 1 && tokens.length > 0) {
				const firstChar = tokens[0]!.charAt(0);
				const ci = lowerText.indexOf(firstChar);
				if (ci !== -1) col = ci + 1;
			}
			results.push({
				file: match[1]!,
				line: parseInt(match[2]!, 10),
				column: col,
				text: text.trim(),
			});
		}
	}
	return results;
}

/** Built-in file scan for regex search (no ripgrep available). */
function builtinRegexSearch(query: string, limit: number, projectRoot: string, pattern: string): FulltextMatch[] {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "gi");
	} catch {
		// Invalid regex pattern — fall back to literal search with annotation
		const results = builtinFulltextSearch(query, limit, projectRoot);
		return results;
	}

	const results: FulltextMatch[] = [];
	const skipDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "target", "__pycache__"]);
	const skipFiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".min.js", ".min.css"];

	function scanDir(dir: string): void {
		if (results.length >= limit) return;
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry === "." || entry === "..") continue;
			const fullPath = join(dir, entry);

			if (entry.startsWith(".") && entry !== ".github") continue;
			if (skipDirs.has(entry)) continue;
			if (skipFiles.some((s) => entry.includes(s))) continue;

			try {
				const st = statSync(fullPath);
				if (st.isDirectory()) {
					scanDir(fullPath);
				} else {
					const ext = entry.split(".").pop()?.toLowerCase();
					const textExts = new Set([
						"ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "kt", "swift",
						"c", "cpp", "h", "hpp", "css", "scss", "less", "html", "vue", "svelte",
						"json", "yaml", "yml", "toml", "md", "txt", "xml", "svg", "sh", "bash",
						"zsh", "sql", "graphql", "prisma",
					]);
					if (ext && !textExts.has(ext)) continue;

					const content = readFileSync(fullPath, "utf-8");
					const lines = content.split("\n");
					for (let i = 0; i < lines.length && results.length < limit; i++) {
						regex.lastIndex = 0;
						const match = regex.exec(lines[i]!);
						if (match) {
							results.push({
								file: fullPath.replace(projectRoot + "/", ""),
								line: i + 1,
								column: match.index + 1,
								text: lines[i]!.trim(),
							});
						}
					}
				}
			} catch {
				// skip unreadable files
			}
		}
	}

	scanDir(projectRoot);
	return results;
}

/** Find ripgrep binary on the system, returning its path or null. */
function findRipgrep(): string | null {
	const candidates = ["/usr/bin/rg", "/usr/local/bin/rg"];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	try {
		const result = execSync("which rg 2>/dev/null || true", { encoding: "utf-8", timeout: 3000 }).toString().trim();
		if (result) return result;
	} catch {
		/* not found */
	}
	return null;
}

function parseRipgrepOutput(output: string, query: string, limit: number): FulltextMatch[] {
	const results: FulltextMatch[] = [];
	const lines = output.split("\n").filter(Boolean);

	// rg --context 1 outputs alternating content/context lines
	for (let i = 0; i < lines.length && results.length < limit; i++) {
		const line = lines[i]!;
		// Skip context lines (starting with -)
		if (line.startsWith("-")) continue;

		// Match pattern: <file>:<line>:<content>
		// Handle Windows paths (C:\...) by looking for the last colon before digits
		const match = line.match(/^(.+):(\d+):(.+)/);
		if (match) {
			let file = match[1]!;
			// Fix Windows paths: if file ends with a drive letter like "C", add back the colon
			if (/^[A-Za-z]$/.test(file) && i + 1 < lines.length) {
				// This is likely a Windows path split incorrectly — skip
				continue;
			}
			results.push({
				file,
				line: parseInt(match[2]!, 10),
				column: match[3]!.search(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")) + 1 || 1,
				text: match[3]!.trim(),
			});
		}
	}
	return results;
}

function builtinFulltextSearch(query: string, limit: number, projectRoot: string): FulltextMatch[] {
	const results: FulltextMatch[] = [];
	const lower = query.toLowerCase();

	// Directories to skip
	const skipDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "target", "__pycache__"]);
	const skipFiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".min.js", ".min.css"];

	function scanDir(dir: string): void {
		if (results.length >= limit) return;
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry === "." || entry === "..") continue;
			const fullPath = join(dir, entry);

			// Skip hidden files/dirs (except .github)
			if (entry.startsWith(".") && entry !== ".github") continue;
			if (skipDirs.has(entry)) continue;
			if (skipFiles.some((s) => entry.includes(s))) continue;

			try {
				const st = statSync(fullPath);
				if (st.isDirectory()) {
					scanDir(fullPath);
				} else {
					// Check if it's a text file by extension
					const ext = entry.split(".").pop()?.toLowerCase();
					const textExts = new Set([
						"ts",
						"tsx",
						"js",
						"jsx",
						"py",
						"rs",
						"go",
						"java",
						"kt",
						"swift",
						"c",
						"cpp",
						"h",
						"hpp",
						"css",
						"scss",
						"less",
						"html",
						"vue",
						"svelte",
						"json",
						"yaml",
						"yml",
						"toml",
						"md",
						"txt",
						"xml",
						"svg",
						"sh",
						"bash",
						"zsh",
						"sql",
						"graphql",
						"prisma",
					]);
					if (ext && !textExts.has(ext)) continue;

					const content = readFileSync(fullPath, "utf-8");
					const lines = content.split("\n");
					for (let i = 0; i < lines.length && results.length < limit; i++) {
						if (lines[i]!.toLowerCase().includes(lower)) {
							results.push({
								file: fullPath.replace(projectRoot + "/", ""),
								line: i + 1,
								column: lines[i]!.toLowerCase().indexOf(lower) + 1,
								text: lines[i]!.trim(),
							});
						}
					}
				}
			} catch {
				// skip unreadable files
			}
		}
	}

	scanDir(projectRoot);
	return results;
}

function formatFulltextResult(results: FulltextMatch[], query: string): string {
	if (results.length === 0) {
		return `No results found for query: "${query}"`;
	}

	const lines: string[] = [`## Full-Text Search: "${query}" (${results.length} results)`, ""];
	for (let i = 0; i < results.length; i++) {
		const r = results[i]!;
		lines.push(
			`${i + 1}. \`${r.file}:${r.line}:${r.column}\` — ${r.text.length > 80 ? r.text.slice(0, 80) + "..." : r.text}`,
		);
	}

	// Add Next recommendations
	const nextItems = getNextForTool("codesearch");
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

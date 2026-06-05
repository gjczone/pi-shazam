/**
 * pi-shazam tools/codesearch — BM25 symbol search.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { isNonSourceFile } from "../core/filter.js";

export function registerCodesearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_codesearch",
		label: "Code Search (BM25)",
		description: `\
MUST call to search for symbols or source text across the project.
Two modes: target="symbol" (default) uses BM25 semantic ranking on
symbol names (camelCase/snake_case aware). target="code" uses full-text
search via ripgrep with context snippets.

Scenario: finding all error handling patterns. Locating all callers of
a function by name. Searching for literal text across the codebase.
Finding TODO/FIXME comments. Exploring code before making edits.`,
		parameters: Type.Object({
			query: Type.String(),
			target: Type.Optional(Type.Union([Type.Literal("symbol"), Type.Literal("code")])),
			topN: Type.Optional(Type.Number()),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const target = params.target ?? "symbol";
			const graph = scanProject(".");

			if (target === "code") {
				const result = executeFulltextSearch(params.query, params.topN);
				return {
					content: [
						{
							type: "text",
							text: json
								? JSON.stringify({
										schema_version: "1.0",
										command: "codesearch",
										status: "ok",
										result: { query: params.query, target: "code", results: result.length },
									})
								: formatFulltextResult(result, params.query),
						},
					],
				};
			}

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
									result: { query: params.query, target: "symbol", results: result.length },
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
		// Skip non-source files (config, generated, lockfiles)
		if (isNonSourceFile(sym.file)) continue;

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

// ── Full-text search (target="code") ────────────────────────────────────────────

interface FulltextMatch {
	file: string;
	line: number;
	column: number;
	text: string;
}

function executeFulltextSearch(query: string, topN?: number): FulltextMatch[] {
	const limit = topN ?? 20;

	// Try ripgrep first (fastest, respects .gitignore)
	if (existsSync("/usr/bin/rg") || existsSync("/usr/local/bin/rg") || execSync("which rg 2>/dev/null || true").toString().trim()) {
		try {
			const output = execSync(
				`rg --no-heading -n --max-count 20 --context 1 -i -g '!.git' -g '!node_modules' -g '!dist' -g '!*.lock' -g '!package-lock.json' -g '!yarn.lock' -g '!pnpm-lock.yaml' ${JSON.stringify(query)} 2>/dev/null | head -${limit * 3}`,
				{ encoding: "utf-8", timeout: 5000 },
			);
			return parseRipgrepOutput(output, query, limit);
		} catch {
			// ripgrep found nothing or errored — fall through to built-in
		}
	}

	// Fallback: built-in file scan
	return builtinFulltextSearch(query, limit);
}

function parseRipgrepOutput(output: string, query: string, limit: number): FulltextMatch[] {
	const results: FulltextMatch[] = [];
	const lines = output.split("\n").filter(Boolean);

	// rg --context 1 outputs alternating content/context lines
	for (let i = 0; i < lines.length && results.length < limit; i++) {
		const line = lines[i]!;
		// Skip context lines (starting with -)
		if (line.startsWith("-")) continue;

		const match = line.match(/^([^:]+):(\d+):(.+)/);
		if (match) {
			results.push({
				file: match[1]!,
				line: parseInt(match[2]!, 10),
				column: match[3]!.search(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")) + 1 || 1,
				text: match[3]!.trim(),
			});
		}
	}
	return results;
}

function builtinFulltextSearch(query: string, limit: number): FulltextMatch[] {
	const results: FulltextMatch[] = [];
	const lower = query.toLowerCase();
	const projectRoot = process.cwd();

	// Directories to skip
	const skipDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "target", "__pycache__"]);
	const skipFiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".min.js", ".min.css"];

	function scanDir(dir: string): void {
		if (results.length >= limit) return;
		let entries: string[] = [];
		try {
			entries = execSync(`ls -1a ${JSON.stringify(dir)} 2>/dev/null`, { encoding: "utf-8", timeout: 1000 }).split("\n").filter(Boolean);
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
				const stat = execSync(`stat -c %F ${JSON.stringify(fullPath)} 2>/dev/null`, { encoding: "utf-8", timeout: 1000 }).trim();
				if (stat === "directory") {
					scanDir(fullPath);
				} else {
					// Check if it's a text file by extension
					const ext = entry.split(".").pop()?.toLowerCase();
					const textExts = new Set(["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "kt", "swift", "c", "cpp", "h", "hpp", "css", "scss", "less", "html", "vue", "svelte", "json", "yaml", "yml", "toml", "md", "txt", "xml", "svg", "sh", "bash", "zsh", "sql", "graphql", "prisma"]);
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

	const lines: string[] = [
		`## Full-Text Search: "${query}" (${results.length} results)`,
		"",
	];
	for (let i = 0; i < results.length; i++) {
		const r = results[i]!;
		lines.push(
			`${i + 1}. \`${r.file}:${r.line}:${r.column}\` — ${r.text.length > 80 ? r.text.slice(0, 80) + "..." : r.text}`,
		);
	}
	return lines.join("\n");
}

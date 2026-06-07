/**
 * pi-shazam MCP tools — register all analysis tools as MCP tools.
 * Each handler is wrapped with withLogging() for usage analytics.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RepoGraph } from "../core/graph.js";
import { executeOverview } from "../tools/overview.js";
import { executeImpact } from "../tools/impact.js";
import { executeCodesearch, executeFulltextSearch } from "../tools/codesearch.js";
import { executeSymbolWithMode } from "../tools/symbol.js";
import { executeFileDetail } from "../tools/file_detail.js";
import { executeCallChain, getFlatReferences, formatFlatReferences } from "../tools/call_chain.js";
import { executeHover, formatHoverResult } from "../tools/hover.js";
import { executeFindTests } from "../tools/find_tests.js";
import { executeHotspots } from "../tools/hotspots.js";
import { executeFix } from "../tools/fix.js";
import { executeVerify } from "../tools/verify.js";
import { executeTypeHierarchy } from "../tools/type_hierarchy.js";
import { executeRenameSymbol } from "../tools/rename_symbol.js";
import { executeSafeDelete } from "../tools/safe_delete.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Logging ──────────────────────────────────────────────────────

const LOG_DIR = join(homedir(), ".kimi-code", "audit");

function logMCP(entry: Record<string, unknown>): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(
			join(LOG_DIR, "shazam-calls.log"),
			JSON.stringify({
				ts: new Date().toISOString(),
				source: "mcp",
				...entry,
			}) + "\n",
			"utf-8",
		);
	} catch {
		/* silent */
	}
}

type Content = { content: { type: "text"; text: string }[] };

function withLogging(
	tool: string,
	fn: (args: Record<string, unknown>) => Promise<Content>,
): (args: Record<string, unknown>) => Promise<Content> {
	return async (args) => {
		const t0 = Date.now();
		logMCP({ tool, event: "start", params: JSON.stringify(args).slice(0, 200) });
		try {
			const result = await fn(args);
			logMCP({
				tool,
				event: "end",
				durationMs: Date.now() - t0,
				success: true,
				resultSize: result.content[0]?.text?.length ?? 0,
			});
			return result;
		} catch (err) {
			logMCP({ tool, event: "end", durationMs: Date.now() - t0, success: false, error: String(err).slice(0, 300) });
			throw err;
		}
	};
}

// ── Registration ─────────────────────────────────────────────────

export function registerAllTools(server: McpServer, graph: RepoGraph, projectRoot: string): void {
	server.registerTool(
		"shazam_overview",
		{
			description:
				"When you first enter a project or return after changes — use this to understand the codebase before reading a single file. Returns module dependency map, top-10 PageRank files, key dependencies, recent git changes, entry points, reading order, and HTTP routes.",
			inputSchema: z.object({ filter: z.string().optional().describe("Optional keyword to filter files") }),
		},
		withLogging("shazam_overview", async ({ filter }) => {
			const text = executeOverview(graph, projectRoot, filter as string | undefined);
			return { content: [{ type: "text", text }] };
		}),
	);

	server.registerTool(
		"shazam_impact",
		{
			description:
				"Required before editing 2+ files or any shared/exported module. Returns every file, symbol, and test affected by your planned changes.",
			inputSchema: z.object({ files: z.array(z.string()).describe("List of file paths to analyze") }),
		},
		withLogging("shazam_impact", async ({ files }) => {
			const text = executeImpact(graph, files as string[]);
			return { content: [{ type: "text", text }] };
		}),
	);

	server.registerTool(
		"shazam_codesearch",
		{
			description:
				"Don't reach for grep or raw text search. Use this — it ranks results by relevance (BM25), understands camelCase/snake_case boundaries, and enriches hits with LSP workspace symbols.",
			inputSchema: z.object({
				query: z.string().describe("Search query text"),
				target: z.enum(["symbol", "code"]).optional().default("symbol").describe("symbol or code"),
			}),
		},
		withLogging("shazam_codesearch", async ({ query, target }) => {
			if (target === "code") {
				const results = executeFulltextSearch(query as string);
				return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
			}
			const scored = executeCodesearch(graph, query as string);
			const results = scored.map(({ sym, score }) => ({ ...sym, score }));
			return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
		}),
	);

	server.registerTool(
		"shazam_symbol",
		{
			description:
				"When you need to look up a symbol before importing or calling it — returns definition, kind, signature, callers, and callees in one call. Use mode=state for enum/state analysis.",
			inputSchema: z.object({
				name: z.string().describe("Symbol name to look up"),
				mode: z.enum(["state"]).optional().describe("Use 'state' for enum/state map analysis"),
				file: z.string().optional().describe("Optional file path to scope the search"),
			}),
		},
		withLogging("shazam_symbol", async ({ name, mode, file }) => {
			const text = executeSymbolWithMode(graph, name as string, mode as string | undefined, file as string | undefined);
			return { content: [{ type: "text", text }] };
		}),
	);

	server.registerTool(
		"shazam_file_detail",
		{
			description:
				"When you are about to edit a file you have not read before — this shows structure (symbols, signatures, visibility, PageRank), not just syntax.",
			inputSchema: z.object({ file: z.string().describe("Path to the file to analyze") }),
		},
		withLogging("shazam_file_detail", async ({ file }) => {
			const text = executeFileDetail(graph, file as string);
			return { content: [{ type: "text", text }] };
		}),
	);

	server.registerTool(
		"shazam_call_chain",
		{
			description:
				"Without this, you ship bugs. Traces ALL upstream callers, downstream callees, and references for any symbol.",
			inputSchema: z.object({
				symbol: z.string().describe("Symbol name to trace"),
				depth: z.number().int().min(1).max(10).optional().default(2).describe("Traversal depth (default 2)"),
				flat: z.boolean().optional().default(false).describe("Return a flat list of all references"),
			}),
		},
		withLogging("shazam_call_chain", async ({ symbol, depth, flat }) => {
			if (flat) {
				const refs = getFlatReferences(graph, symbol as string);
				const text = formatFlatReferences(refs, symbol as string);
				return { content: [{ type: "text", text }] };
			}
			const text = executeCallChain(graph, symbol as string, (depth as number) ?? 2);
			return { content: [{ type: "text", text }] };
		}),
	);

	server.registerTool(
		"shazam_hover",
		{
			description:
				"After finding a symbol, use this to get its full type signature, documentation comments, and JSDoc.",
			inputSchema: z.object({
				name: z.string().describe("Symbol name"),
				file: z.string().optional().describe("Optional file path to scope lookup"),
			}),
		},
		withLogging("shazam_hover", async ({ name, file }) => {
			const result = await executeHover(graph, name as string, file as string | undefined);
			const text = formatHoverResult(result, name as string);
			return { content: [{ type: "text", text }] };
		}),
	);

	server.registerTool(
		"shazam_find_tests",
		{
			description: "When adding tests or modifying source code — discover which test files cover a module.",
			inputSchema: z.object({
				sourceFile: z.string().optional().describe("Path to source file to find tests for"),
				module: z.string().optional().describe("Module name to scope search"),
			}),
		},
		withLogging("shazam_find_tests", async ({ sourceFile, module: mod }) => {
			const result = executeFindTests(graph, projectRoot, {
				sourceFile: sourceFile as string | undefined,
				module: mod as string | undefined,
			});
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		}),
	);

	server.registerTool(
		"shazam_hotspots",
		{
			description:
				"Without this, you optimize the wrong files. Returns files ranked by (symbol density x PageRank) — where bugs have the highest blast radius.",
			inputSchema: z.object({}),
		},
		withLogging("shazam_hotspots", async () => {
			const text = executeHotspots(graph);
			return { content: [{ type: "text", text }] };
		}),
	);

	server.registerTool(
		"shazam_verify",
		{
			description:
				"After every write or edit, run this to confirm no errors. Runs LSP diagnostics + graph analysis. Verdict: PASS / WARN / FAIL.",
			inputSchema: z.object({
				quick: z.boolean().optional().default(false).describe("Fast git-change-only check (~2s)"),
				lspOnly: z.boolean().optional().default(false).describe("LSP diagnostics only, skip graph analysis"),
			}),
		},
		withLogging("shazam_verify", async ({ quick, lspOnly }) => {
			const text = executeVerify(graph, projectRoot, { quick: quick as boolean, lspOnly: lspOnly as boolean });
			return { content: [{ type: "text", text }] };
		}),
	);

	server.registerTool(
		"shazam_type_hierarchy",
		{
			description:
				"When working with classes or interfaces — see the full inheritance chain (supertypes and subtypes) in one call.",
			inputSchema: z.object({
				name: z.string().describe("Symbol name"),
				direction: z
					.enum(["both", "supertypes", "subtypes"])
					.optional()
					.default("both")
					.describe("Traversal direction"),
			}),
		},
		withLogging("shazam_type_hierarchy", async ({ name, direction }) => {
			const result = executeTypeHierarchy(
				graph,
				name as string,
				(direction as "both" | "supertypes" | "subtypes") ?? "both",
			);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		}),
	);

	server.registerTool(
		"shazam_rename_symbol",
		{
			description:
				"Safety gate before renaming. Step 1: call shazam_call_chain to review references. Step 2: use this to rename. Step 3: call shazam_verify to confirm.",
			inputSchema: z.object({
				symbol: z.string().describe("Current symbol name to rename"),
				newName: z.string().describe("New symbol name"),
				dryRun: z.boolean().optional().default(false).describe("Preview only, do not modify files"),
			}),
		},
		withLogging("shazam_rename_symbol", async ({ symbol, newName, dryRun }) => {
			const result = await executeRenameSymbol(graph, symbol as string, newName as string, dryRun as boolean);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		}),
	);

	server.registerTool(
		"shazam_safe_delete",
		{
			description:
				"Safety gate before removing any symbol. Verifies zero incoming references before providing deletion instructions.",
			inputSchema: z.object({
				symbol: z.string().describe("Symbol name to delete"),
				dryRun: z.boolean().optional().default(true).describe("Preview only, do not modify files"),
			}),
		},
		withLogging("shazam_safe_delete", async ({ symbol, dryRun }) => {
			const result = executeSafeDelete(graph, symbol as string, dryRun as boolean);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		}),
	);

	server.registerTool(
		"shazam_fix",
		{
			description:
				"When shazam_verify reports format or lint errors, use this to auto-fix them. Runs nearest-wins formatters (prettier, biome, eslint --fix, ruff, cargo fmt, gofmt). Format only -- never touches logic. Always run with --dry-run first to preview changes before applying.",
			inputSchema: z.object({
				dryRun: z.boolean().optional().default(true).describe("Preview changes without applying"),
				file: z.string().optional().describe("Scope to a single file"),
			}),
		},
		withLogging("shazam_fix", async ({ dryRun, file }) => {
			const text = executeFix(graph, projectRoot, { dryRun: dryRun as boolean, file: file as string | undefined });
			return { content: [{ type: "text", text }] };
		}),
	);
}

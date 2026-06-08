/**
 * pi-shazam MCP tools — register all analysis tools as MCP tools.
 * Each handler is wrapped with withLogging() for usage analytics.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoGraph } from "../core/graph.js";
import { executeOverview } from "../tools/overview.js";
import { executeImpact } from "../tools/impact.js";
import { executeCodesearch, executeFulltextSearch } from "../tools/codesearch.js";
import { executeSymbolWithMode } from "../tools/symbol.js";
import { executeFileDetail } from "../tools/file_detail.js";
import { executeCallChain, getFlatReferences, formatFlatReferences } from "../tools/call_chain.js";
import { executeHover, formatHoverResult } from "../tools/hover.js";
import { executeFindTests, formatFindTestsResult } from "../tools/find_tests.js";
import { executeHotspots } from "../tools/hotspots.js";
import { executeFix } from "../tools/fix.js";
import { executeVerify } from "../tools/verify.js";
import { executeTypeHierarchy, formatTypeHierarchy } from "../tools/type_hierarchy.js";
import { executeRenameSymbol, formatRenameResult } from "../tools/rename_symbol.js";
import { executeSafeDelete, formatSafeDeleteResult } from "../tools/safe_delete.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getToolDefinition } from "../tools/definitions.js";

// ── Logging ──────────────────────────────────────────────────────

// Use pi-shazam-specific audit directory (was .kimi-code/audit for Kimi Code compatibility)
const LOG_DIR = join(homedir(), ".pi", "hooks", "audit");

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
	const overviewDef = getToolDefinition("shazam_overview")!;
	server.registerTool(
		"shazam_overview",
		{
			description: overviewDef.description,
			inputSchema: overviewDef.zodParams,
		},
		withLogging("shazam_overview", async ({ filter }) => {
			const text = executeOverview(graph, projectRoot, filter as string | undefined);
			return { content: [{ type: "text", text }] };
		}),
	);

	const impactDef = getToolDefinition("shazam_impact")!;
	server.registerTool(
		"shazam_impact",
		{
			description: impactDef.description,
			inputSchema: impactDef.zodParams,
		},
		withLogging("shazam_impact", async ({ files }) => {
			const text = executeImpact(graph, files as string[]);
			return { content: [{ type: "text", text }] };
		}),
	);

	const codesearchDef = getToolDefinition("shazam_codesearch")!;
	server.registerTool(
		"shazam_codesearch",
		{
			description: codesearchDef.description,
			inputSchema: codesearchDef.zodParams,
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

	const symbolDef = getToolDefinition("shazam_symbol")!;
	server.registerTool(
		"shazam_symbol",
		{
			description: symbolDef.description,
			inputSchema: symbolDef.zodParams,
		},
		withLogging("shazam_symbol", async ({ name, mode, file }) => {
			const text = executeSymbolWithMode(graph, name as string, mode as string | undefined, file as string | undefined);
			return { content: [{ type: "text", text }] };
		}),
	);

	const fileDetailDef = getToolDefinition("shazam_file_detail")!;
	server.registerTool(
		"shazam_file_detail",
		{
			description: fileDetailDef.description,
			inputSchema: fileDetailDef.zodParams,
		},
		withLogging("shazam_file_detail", async ({ file }) => {
			const text = executeFileDetail(graph, file as string);
			return { content: [{ type: "text", text }] };
		}),
	);

	const callChainDef = getToolDefinition("shazam_call_chain")!;
	server.registerTool(
		"shazam_call_chain",
		{
			description: callChainDef.description,
			inputSchema: callChainDef.zodParams,
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

	const hoverDef = getToolDefinition("shazam_hover")!;
	server.registerTool(
		"shazam_hover",
		{
			description: hoverDef.description,
			inputSchema: hoverDef.zodParams,
		},
		withLogging("shazam_hover", async ({ name, file }) => {
			const result = await executeHover(graph, name as string, file as string | undefined);
			const text = formatHoverResult(result, name as string);
			return { content: [{ type: "text", text }] };
		}),
	);

	const findTestsDef = getToolDefinition("shazam_find_tests")!;
	server.registerTool(
		"shazam_find_tests",
		{
			description: findTestsDef.description,
			inputSchema: findTestsDef.zodParams,
		},
		withLogging("shazam_find_tests", async ({ sourceFile, module: mod }) => {
			const result = executeFindTests(graph, projectRoot, {
				sourceFile: sourceFile as string | undefined,
				module: mod as string | undefined,
			});
			return { content: [{ type: "text", text: formatFindTestsResult(result, sourceFile as string | undefined, mod as string | undefined) }] };
		}),
	);

	const hotspotsDef = getToolDefinition("shazam_hotspots")!;
	server.registerTool(
		"shazam_hotspots",
		{
			description: hotspotsDef.description,
			inputSchema: hotspotsDef.zodParams,
		},
		withLogging("shazam_hotspots", async () => {
			const text = executeHotspots(graph);
			return { content: [{ type: "text", text }] };
		}),
	);

	const verifyDef = getToolDefinition("shazam_verify")!;
	server.registerTool(
		"shazam_verify",
		{
			description: verifyDef.description,
			inputSchema: verifyDef.zodParams,
		},
		withLogging("shazam_verify", async ({ quick, lspOnly }) => {
			const text = executeVerify(graph, projectRoot, { quick: quick as boolean, lspOnly: lspOnly as boolean });
			return { content: [{ type: "text", text }] };
		}),
	);

	const typeHierarchyDef = getToolDefinition("shazam_type_hierarchy")!;
	server.registerTool(
		"shazam_type_hierarchy",
		{
			description: typeHierarchyDef.description,
			inputSchema: typeHierarchyDef.zodParams,
		},
		withLogging("shazam_type_hierarchy", async ({ name, direction }) => {
			const result = await executeTypeHierarchy(
				graph,
				name as string,
				(direction as "both" | "supertypes" | "subtypes") ?? "both",
			);
			return { content: [{ type: "text", text: formatTypeHierarchy(result, name as string) }] };
		}),
	);

	const renameSymbolDef = getToolDefinition("shazam_rename_symbol")!;
	server.registerTool(
		"shazam_rename_symbol",
		{
			description: renameSymbolDef.description,
			inputSchema: renameSymbolDef.zodParams,
		},
		withLogging("shazam_rename_symbol", async ({ symbol, newName, dryRun }) => {
			const result = await executeRenameSymbol(graph, symbol as string, newName as string, dryRun as boolean);
			return { content: [{ type: "text", text: formatRenameResult(result, symbol as string, newName as string, dryRun as boolean) }] };
		}),
	);

	const safeDeleteDef = getToolDefinition("shazam_safe_delete")!;
	server.registerTool(
		"shazam_safe_delete",
		{
			description: safeDeleteDef.description,
			inputSchema: safeDeleteDef.zodParams,
		},
		withLogging("shazam_safe_delete", async ({ symbol, dryRun }) => {
			const result = executeSafeDelete(graph, symbol as string, dryRun as boolean);
			return { content: [{ type: "text", text: formatSafeDeleteResult(result, symbol as string) }] };
		}),
	);

	const fixDef = getToolDefinition("shazam_fix")!;
	server.registerTool(
		"shazam_fix",
		{
			description: fixDef.description,
			inputSchema: fixDef.zodParams,
		},
		withLogging("shazam_fix", async ({ dryRun, file }) => {
			const text = executeFix(graph, projectRoot, { dryRun: dryRun as boolean, file: file as string | undefined });
			return { content: [{ type: "text", text }] };
		}),
	);
}

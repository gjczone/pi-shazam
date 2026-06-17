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
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LspManager } from "../lsp/manager.js";
import { getToolDefinition } from "../tools/definitions.js";
import { truncateOutput } from "../core/output.js";
import { redact } from "../core/redact.js";
import { AUDIT_LOG_DIR, rotateAuditLog } from "../core/audit-log.js";

// ── Logging ──────────────────────────────────────────────────────

// Use pi-shazam-specific audit directory (was .kimi-code/audit for Kimi Code compatibility)
const LOG_DIR = AUDIT_LOG_DIR;

// Async mutex keyed on LOG_DIR to serialize log writes and rotations.
let _logLock: Promise<void> = Promise.resolve();
function withLogLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = _logLock;
	let release: () => void;
	_logLock = new Promise<void>((r) => {
		release = r;
	});
	return prev.then(fn).finally(() => release!());
}

async function logMCP(entry: Record<string, unknown>): Promise<void> {
	await withLogLock(async () => {
		try {
			await mkdir(LOG_DIR, { recursive: true });
			await rotateAuditLog(join(LOG_DIR, "shazam-calls.log"));
			await appendFile(
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
	});
}

type Content = { content: { type: "text"; text: string }[] };

function withLogging(
	tool: string,
	fn: (args: Record<string, unknown>) => Promise<Content>,
): (args: Record<string, unknown>) => Promise<Content> {
	return async (args) => {
		const t0 = Date.now();
		void logMCP({ tool, event: "start", params: redact(JSON.stringify(args).slice(0, 200)) });
		try {
			const result = await fn(args);
			void logMCP({
				tool,
				event: "end",
				durationMs: Date.now() - t0,
				success: true,
				resultSize: result.content[0]?.text?.length ?? 0,
			});
			return result;
		} catch (err) {
			void logMCP({
				tool,
				event: "end",
				durationMs: Date.now() - t0,
				success: false,
				error: redact(String(err).slice(0, 300)),
			});
			throw err;
		}
	};
}

// ── Registration ─────────────────────────────────────────────────

export function registerAllTools(
	server: McpServer,
	getGraph: () => RepoGraph,
	projectRoot: string,
	_lspManager?: LspManager,
): void {
	const overviewDef = getToolDefinition("shazam_overview")!;
	server.registerTool(
		"shazam_overview",
		{
			description: overviewDef.description,
			inputSchema: overviewDef.zodParams,
		},
		withLogging("shazam_overview", async ({ filter, maxTokens }) => {
			let text = executeOverview(getGraph(), projectRoot, filter as string | undefined);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
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
		withLogging("shazam_impact", async ({ files, withSymbols, compact, depth, maxTokens }) => {
			let text = executeImpact(getGraph(), files as string[], {
				withSymbols: (withSymbols as boolean) ?? false,
				compact: (compact as boolean) ?? false,
				depth: (depth as number) ?? 3,
			});
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
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
		withLogging("shazam_codesearch", async ({ query, target, mode, topN, maxTokens }) => {
			if (target === "code") {
				const results = executeFulltextSearch(
					query as string,
					topN as number | undefined,
					projectRoot,
					mode as string | undefined,
				);
				let text = JSON.stringify(results, null, 2);
				if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
				return { content: [{ type: "text", text }] };
			}
			const scored = executeCodesearch(getGraph(), query as string, topN as number | undefined);
			const results = scored.map(({ sym, score }) => ({ ...sym, score }));
			let text = JSON.stringify(results, null, 2);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);

	const symbolDef = getToolDefinition("shazam_symbol")!;
	server.registerTool(
		"shazam_symbol",
		{
			description: symbolDef.description,
			inputSchema: symbolDef.zodParams,
		},
		withLogging("shazam_symbol", async ({ name, mode, file, maxTokens }) => {
			let text = executeSymbolWithMode(
				getGraph(),
				name as string,
				mode as string | undefined,
				file as string | undefined,
			);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
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
		withLogging("shazam_file_detail", async ({ file, maxTokens }) => {
			let text = executeFileDetail(getGraph(), file as string);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
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
		withLogging("shazam_call_chain", async ({ symbol, depth, flat, direction, maxTokens }) => {
			const dir = (direction as "incoming" | "outgoing" | "both") ?? "both";
			if (flat) {
				const refs = getFlatReferences(getGraph(), symbol as string, dir);
				let text = formatFlatReferences(refs, symbol as string);
				if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
				return { content: [{ type: "text", text }] };
			}
			let text = executeCallChain(getGraph(), symbol as string, (depth as number) ?? 2, dir);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
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
		withLogging("shazam_hover", async ({ name, file, maxTokens }) => {
			const result = await executeHover(getGraph(), name as string, file as string | undefined);
			let text = formatHoverResult(result, name as string);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
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
		withLogging("shazam_find_tests", async ({ sourceFile, module: mod, maxTokens }) => {
			const result = executeFindTests(getGraph(), projectRoot, {
				sourceFile: sourceFile as string | undefined,
				module: mod as string | undefined,
			});
			let text = formatFindTestsResult(result, sourceFile as string | undefined, mod as string | undefined);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return {
				content: [
					{
						type: "text",
						text,
					},
				],
			};
		}),
	);

	const hotspotsDef = getToolDefinition("shazam_hotspots")!;
	server.registerTool(
		"shazam_hotspots",
		{
			description: hotspotsDef.description,
			inputSchema: hotspotsDef.zodParams,
		},
		withLogging("shazam_hotspots", async ({ topN, maxTokens }) => {
			let text = executeHotspots(getGraph(), topN as number | undefined);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);

	// TODO: Replace synchronous executeVerify with exported executeVerifyTextAsync/executeVerifyJsonAsync
	// once they are exported from tools/verify.ts. The async versions support LSP enrichment
	// which is needed for accurate MCP diagnostics. See issue #327 P2 #17.
	const verifyDef = getToolDefinition("shazam_verify")!;
	server.registerTool(
		"shazam_verify",
		{
			description: verifyDef.description,
			inputSchema: verifyDef.zodParams,
		},
		withLogging(
			"shazam_verify",
			async ({ quick, lspOnly, preCommit, delta, maxFiles, noCascade, noSecrets, maxTokens }) => {
				let text = executeVerify(getGraph(), projectRoot, {
					quick: quick as boolean,
					lspOnly: lspOnly as boolean,
					preCommit: preCommit as boolean,
					delta: delta as boolean,
					maxFiles: maxFiles as number,
					noCascade: noCascade as boolean,
					noSecrets: noSecrets as boolean,
				});
				if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
				return { content: [{ type: "text", text }] };
			},
		),
	);

	const typeHierarchyDef = getToolDefinition("shazam_type_hierarchy")!;
	server.registerTool(
		"shazam_type_hierarchy",
		{
			description: typeHierarchyDef.description,
			inputSchema: typeHierarchyDef.zodParams,
		},
		withLogging("shazam_type_hierarchy", async ({ name, direction, maxTokens }) => {
			const result = await executeTypeHierarchy(
				getGraph(),
				name as string,
				(direction as "both" | "supertypes" | "subtypes") ?? "both",
			);
			let text = formatTypeHierarchy(result, name as string);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);

	const renameSymbolDef = getToolDefinition("shazam_rename_symbol")!;
	server.registerTool(
		"shazam_rename_symbol",
		{
			description: renameSymbolDef.description,
			inputSchema: renameSymbolDef.zodParams,
		},
		withLogging("shazam_rename_symbol", async ({ symbol, newName, dryRun, maxTokens }) => {
			const result = await executeRenameSymbol(getGraph(), symbol as string, newName as string, dryRun as boolean);
			let text = formatRenameResult(result, symbol as string, newName as string, dryRun as boolean);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return {
				content: [{ type: "text", text }],
			};
		}),
	);

	const safeDeleteDef = getToolDefinition("shazam_safe_delete")!;
	server.registerTool(
		"shazam_safe_delete",
		{
			description: safeDeleteDef.description,
			inputSchema: safeDeleteDef.zodParams,
		},
		withLogging("shazam_safe_delete", async ({ symbol, dryRun, maxTokens }) => {
			const result = executeSafeDelete(getGraph(), symbol as string, dryRun as boolean);
			let text = formatSafeDeleteResult(result, symbol as string);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);

	const fixDef = getToolDefinition("shazam_fix")!;
	server.registerTool(
		"shazam_fix",
		{
			description: fixDef.description,
			inputSchema: fixDef.zodParams,
		},
		withLogging("shazam_fix", async ({ dryRun, file, maxTokens }) => {
			let text = executeFix(getGraph(), projectRoot, { dryRun: dryRun as boolean, file: file as string | undefined });
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);
}

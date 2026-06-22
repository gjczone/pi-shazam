/**
 * pi-shazam MCP tools — register all analysis tools as MCP tools.
 * Each handler is wrapped with withLogging() for usage analytics.
 *
 * Updated for tool consolidation 14→8+1 (issue #362).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoGraph } from "../core/graph.js";
import { executeOverview } from "../tools/overview.js";
import { executeImpact, executeCallChain, getFlatReferences, formatFlatReferences } from "../tools/impact.js";
import { executeLookupAsync, executeFileDetailAsync, executeStateMap } from "../tools/lookup.js";
import { executeFindTests, formatFindTestsResult } from "../tools/find_tests.js";
import { executeFormat } from "../tools/format.js";
import { executeVerifyTextAsync, executeVerifyJsonAsync } from "../tools/verify.js";
import { executeChanges, executeChangesJson } from "../tools/changes.js";
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

const LOG_DIR = AUDIT_LOG_DIR;

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
	// shazam_overview (includes hotspots)
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

	// shazam_lookup (replaces symbol, file_detail, hover, type_hierarchy)
	const lookupDef = getToolDefinition("shazam_lookup")!;
	server.registerTool(
		"shazam_lookup",
		{
			description: lookupDef.description,
			inputSchema: lookupDef.zodParams,
		},
		withLogging("shazam_lookup", async ({ name, mode, file, showCallbacks, direction, maxTokens }) => {
			const nameStr = name as string;
			if (!nameStr) {
				return { content: [{ type: "text", text: "Error: name parameter is required" }] };
			}
			const isFilePath =
				nameStr.includes("/") ||
				nameStr.includes("\\") ||
				/\.(ts|tsx|js|jsx|py|go|rs|dart|json|yaml|yml|mjs|cjs|rb|java|cs|c|cpp|h|hpp|css|scss|less|sh|bash|toml|html|htm|md)$/.test(
					nameStr,
				);
			let text: string;
			if (isFilePath) {
				text = await executeFileDetailAsync(getGraph(), nameStr);
			} else if (mode === "state") {
				text = executeStateMap(getGraph(), nameStr);
			} else {
				text = await executeLookupAsync(
					getGraph(),
					nameStr,
					file as string | undefined,
					(direction as "both" | "supertypes" | "subtypes") ?? "both",
					(showCallbacks as boolean) ?? false,
				);
			}
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);

	// shazam_impact (includes call_chain)
	const impactDef = getToolDefinition("shazam_impact")!;
	server.registerTool(
		"shazam_impact",
		{
			description: impactDef.description,
			inputSchema: impactDef.zodParams,
		},
		withLogging("shazam_impact", async ({ files, symbol, withSymbols, compact, depth, flat, direction, maxTokens }) => {
			const dir = (direction as "incoming" | "outgoing" | "both") ?? "both";
			const d = Math.min(Math.max((depth as number) ?? 3, 1), 10);

			// Symbol mode: call chain analysis
			if (symbol) {
				if (flat) {
					const refs = getFlatReferences(getGraph(), symbol as string, dir);
					let text = formatFlatReferences(refs, symbol as string);
					if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
					return { content: [{ type: "text", text }] };
				}
				let text = executeCallChain(getGraph(), symbol as string, Math.min(d, 10), dir);
				if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
				return { content: [{ type: "text", text }] };
			}

			// File mode: impact analysis
			const filesArr = files as string[] | undefined;
			if (!filesArr || filesArr.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Error: either --symbol (for call chain) or --files (for impact analysis) is required",
						},
					],
				};
			}
			let text = executeImpact(getGraph(), filesArr, {
				withSymbols: (withSymbols as boolean) ?? false,
				compact: (compact as boolean) ?? false,
				depth: d,
			});
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);

	// shazam_verify
	const verifyDef = getToolDefinition("shazam_verify")!;
	server.registerTool(
		"shazam_verify",
		{
			description: verifyDef.description,
			inputSchema: verifyDef.zodParams,
		},
		withLogging(
			"shazam_verify",
			async ({ quick, lspOnly, preCommit, delta, maxFiles, noCascade, noSecrets, maxTokens, json }) => {
				const opts = {
					quick: quick as boolean,
					lspOnly: lspOnly as boolean,
					preCommit: preCommit as boolean,
					delta: delta as boolean,
					maxFiles: maxFiles as number,
					noCascade: noCascade as boolean,
					noSecrets: noSecrets as boolean,
				};
				if (json) {
					const result = await executeVerifyJsonAsync(projectRoot, opts);
					const envelope = JSON.stringify(
						{ schema_version: "1.0", command: "verify", project: projectRoot, status: "ok", result },
						null,
						2,
					);
					let text = envelope;
					if (typeof maxTokens === "number" && maxTokens > 0) {
						text = truncateOutput(envelope.split("\n"), maxTokens);
					}
					return { content: [{ type: "text", text }] };
				}
				let text = await executeVerifyTextAsync(projectRoot, opts);
				if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
				return { content: [{ type: "text", text }] };
			},
		),
	);

	// shazam_changes (new)
	const changesDef = getToolDefinition("shazam_changes")!;
	server.registerTool(
		"shazam_changes",
		{
			description: changesDef.description,
			inputSchema: changesDef.zodParams,
		},
		withLogging("shazam_changes", async ({ maxTokens, json }) => {
			let text: string;
			if (json) {
				text = executeChangesJson(getGraph(), projectRoot);
			} else {
				text = executeChanges(getGraph(), projectRoot);
			}
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);

	// shazam_format (replaces shazam_fix)
	const formatDef = getToolDefinition("shazam_format")!;
	server.registerTool(
		"shazam_format",
		{
			description: formatDef.description,
			inputSchema: formatDef.zodParams,
		},
		withLogging("shazam_format", async ({ dryRun, file, maxTokens }) => {
			let text = executeFormat(getGraph(), projectRoot, {
				dryRun: dryRun as boolean,
				file: file as string | undefined,
			});
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);

	// shazam_find_tests
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
			return { content: [{ type: "text", text }] };
		}),
	);

	// shazam_rename_symbol
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
			return { content: [{ type: "text", text }] };
		}),
	);

	// shazam_safe_delete
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
}

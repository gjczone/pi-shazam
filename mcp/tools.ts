/**
 * pi-shazam MCP tools -- register all analysis tools as MCP tools.
 * Each handler is wrapped with withLogging() for usage analytics.
 *
 * Updated for tool consolidation 14->9 (issue #362).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoGraph } from "../core/graph.js";
import { executeOverview } from "../tools/overview.js";
import { executeImpact, executeCallChain, getFlatReferences, formatFlatReferences } from "../tools/impact.js";
import {
	executeLookupAsync,
	executeFileDetailAsync,
	executeStateMap,
	_executeSearch,
	_formatSearchResults,
	_looksLikeNaturalLanguage,
	_findSymbols,
} from "../tools/lookup.js";
import { executeFormat } from "../tools/format.js";
import { executeVerifyTextAsync, executeVerifyJsonAsync } from "../tools/verify.js";
import { executeChanges, executeChangesJson } from "../tools/changes.js";
import { executeRenameSymbol, formatRenameResult } from "../tools/rename_symbol.js";
import { hasCallChainChecked, recordCallChain } from "../tools/rename-state.js";

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getToolDefinition } from "../tools/definitions.js";
import { validatePathInProject } from "../tools/_factory.js";
import { _logWarn, truncateOutput } from "../core/output.js";
import { redact } from "../core/redact.js";
import { AUDIT_LOG_DIR, rotateAuditLog } from "../core/audit-log.js";

// -- Logging ------------------------------------------------------

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
		} catch (err) {
			_logWarn("logMCP", "audit log write failed", err);
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
		// #544: redact the FULL string first, then truncate. The previous order
		// `redact(s.slice(0, N))` split secrets across the truncation boundary
		// before redact() ever saw them, leaking partial AKIA/ghp_/JWT fragments
		// to the on-disk audit log. Secret patterns in core/redact.ts are
		// full-match only, so a sliced fragment never matches and is written
		// verbatim. Redacting first guarantees no partial secret survives.
		void logMCP({ tool, event: "start", params: redact(JSON.stringify(args)).slice(0, 200) });
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
				error: redact(String(err)).slice(0, 300),
			});
			const redactedMsg = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
			const wrapped = new Error(redactedMsg);
			if (err instanceof Error && err.stack) wrapped.stack = err.stack;
			throw wrapped;
		}
	};
}

// -- Registration -------------------------------------------------

export function registerAllTools(server: McpServer, getGraph: () => RepoGraph, projectRoot: string): void {
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
				return { content: [{ type: "text", text: "Error: name parameter is required" }], isError: true };
			}
			const isFilePath =
				nameStr.includes("/") ||
				nameStr.includes("\\") ||
				/\.(ts|tsx|js|jsx|py|go|rs|dart|json|yaml|yml|mjs|cjs|rb|java|cs|c|cpp|h|hpp|css|scss|less|sh|bash|toml|html|htm|md)$/.test(
					nameStr,
				);
			// Path traversal guard: reject file paths outside project root (issue #395)
			// M9: Use configured projectRoot instead of process.cwd()
			if (isFilePath && !validatePathInProject(nameStr, projectRoot)) {
				return {
					content: [{ type: "text", text: `Error: Path '${nameStr}' is outside the project root and cannot be read.` }],
					isError: true,
				};
			}
			const fileParam = file as string | undefined;
			if (fileParam && !validatePathInProject(fileParam, projectRoot)) {
				return {
					content: [{ type: "text", text: `Error: File path '${fileParam}' is outside the project root.` }],
					isError: true,
				};
			}
			let text: string;
			if (isFilePath) {
				text = await executeFileDetailAsync(getGraph(), nameStr);
			} else if (mode === "state") {
				text = executeStateMap(getGraph(), nameStr);
			} else if (mode === "search") {
				const results = _executeSearch(getGraph(), nameStr);
				text = _formatSearchResults(nameStr, results);
			} else {
				const matches = _findSymbols(getGraph(), nameStr, fileParam);
				if (matches.length === 0 && _looksLikeNaturalLanguage(nameStr)) {
					const results = _executeSearch(getGraph(), nameStr);
					text = _formatSearchResults(nameStr, results);
				} else {
					text = await executeLookupAsync(
						getGraph(),
						nameStr,
						file as string | undefined,
						(direction as "both" | "supertypes" | "subtypes") ?? "both",
						(showCallbacks as boolean) ?? false,
					);
				}
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
				// #447: Record that impact --symbol was run so the rename gate is satisfied
				recordCallChain(symbol as string);
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
					isError: true,
				};
			}
			// #445: Validate user-supplied file paths against project root (path-traversal guard)
			for (const f of filesArr) {
				if (!validatePathInProject(f, projectRoot)) {
					return {
						content: [
							{ type: "text", text: `Error: File path '${f}' is outside the project root and cannot be accessed.` },
						],
						isError: true,
					};
				}
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
			async ({ quick, lspOnly, preCommit, maxFiles, noCascade, noSecrets, maxTokens, json }) => {
				const opts = {
					quick: quick as boolean,
					lspOnly: lspOnly as boolean,
					preCommit: preCommit as boolean,
					maxFiles: (maxFiles as number | undefined) ?? 100,
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
			// #465: validate user-supplied file path against project root.
			// shazam_format was the only file-accepting MCP handler that
			// skipped validatePathInProject, allowing formatters (--write)
			// to modify files outside the configured project root.
			if (file && !validatePathInProject(file as string, projectRoot)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: file path '${file}' is outside the project root and cannot be accessed.`,
						},
					],
					isError: true,
				};
			}
			let text = await executeFormat(getGraph(), projectRoot, {
				dryRun: (dryRun as boolean) ?? true,
				file: file as string | undefined,
			});
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
			const effectiveDryRun = (dryRun as boolean) ?? true;
			// Enforce impact-check safety gate: block non-dry-run unless shazam_impact --symbol was run
			if (!effectiveDryRun && !hasCallChainChecked(symbol as string)) {
				return {
					content: [
						{
							type: "text" as const,
							text: [
								"[BLOCKED] Rename aborted - shazam_impact --symbol has not been run for this symbol.",
								"",
								`Before renaming \`${symbol as string}\`, you MUST run:`,
								`  shazam_impact --symbol "${symbol as string}" --direction both`,
								"",
								"Review all callers and callees, then re-invoke shazam_rename_symbol with dryRun=false.",
							].join("\n"),
						},
					],
					isError: true,
				};
			}
			const result = await executeRenameSymbol(
				getGraph(),
				symbol as string,
				newName as string,
				effectiveDryRun,
				projectRoot,
			);
			let text = formatRenameResult(result, symbol as string, newName as string, effectiveDryRun);
			if (typeof maxTokens === "number" && maxTokens > 0) text = truncateOutput(text.split("\n"), maxTokens);
			return { content: [{ type: "text", text }] };
		}),
	);
}

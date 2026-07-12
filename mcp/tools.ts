/**
 * pi-shazam MCP tools -- register all analysis tools as MCP tools.
 *
 * Each handler delegates to the shared dispatcher in tools/_dispatchers.ts.
 * The dispatcher is the single source of truth for validation, routing,
 * and mode dispatch. MCP handlers only handle: logging, truncation,
 * and content envelope wrapping.
 *
 * Refactored from ~450 lines to ~100 lines (issue #618).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoGraph } from "../core/graph.js";
import {
	dispatchOverview,
	dispatchLookup,
	dispatchImpact,
	dispatchVerify,
	dispatchChanges,
	dispatchFormat,
	dispatchRenameSymbol,
	type DispatchResult,
} from "../tools/_dispatchers.js";

import { join } from "node:path";
import { getToolDefinition } from "../tools/definitions.js";
import { truncateOutput } from "../core/output.js";
import { redact } from "../core/redact.js";
import { AUDIT_LOG_DIR, ts, writeJsonl } from "../core/audit-log.js";

// -- Logging ------------------------------------------------------

const LOG_FILE = join(AUDIT_LOG_DIR, "shazam-calls.log");

function logMCP(entry: Record<string, unknown>): void {
	writeJsonl(LOG_FILE, { ts: ts(), source: "mcp", ...entry });
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
			// #597: Do NOT copy err.stack onto the re-thrown Error -- the
			// original stack trace contains absolute project paths and host
			// layout details that must never leak to MCP clients.
			// Log the original stack server-side for debugging, then throw
			// a sanitized Error that gets its own fresh stack at this site.
			if (err instanceof Error && err.stack) {
				void logMCP({ tool, event: "error_stack", stack: redact(err.stack).slice(0, 1000) });
			}
			throw new Error(redactedMsg);
		}
	};
}

// -- Thin MCP wrapper -------------------------------------------------

type DispatcherFn = (
	graph: RepoGraph,
	params: Record<string, unknown>,
	projectRoot: string,
) => DispatchResult | Promise<DispatchResult>;

/**
 * Register a tool on the MCP server using a shared dispatcher.
 * The dispatcher handles all validation and dispatch logic.
 * This wrapper handles: logging, truncation, and content envelope wrapping.
 */
function registerMcpTool(
	server: McpServer,
	name: string,
	dispatch: DispatcherFn,
	getGraph: () => RepoGraph,
	projectRoot: string,
): void {
	const def = getToolDefinition(name)!;
	server.registerTool(
		name,
		{
			description: def.description,
			inputSchema: def.zodParams,
		},
		withLogging(name, async (args) => {
			const graph = getGraph();
			const result = await dispatch(graph, args, projectRoot);
			let text = result.text;
			if (typeof args.maxTokens === "number" && (args.maxTokens as number) > 0 && !args.json) {
				text = truncateOutput(text.split("\n"), args.maxTokens as number);
			}
			// Issue #731: non-overview tools must also surface the truncated flag
			// so the agent knows results may be incomplete when MAX_FILES was hit.
			if (graph.truncated === true && !args.json) {
				text +=
					"\n\n[WARNING] File count exceeded MAX_FILES — the analysis graph is incomplete. Results may miss dependencies.";
			}
			const out: Record<string, unknown> = { content: [{ type: "text" as const, text }] };
			if (result.isError) out.isError = true;
			return out as Content;
		}),
	);
}

// -- Registration -------------------------------------------------

export function registerAllTools(server: McpServer, getGraph: () => RepoGraph, projectRoot: string): void {
	registerMcpTool(server, "shazam_overview", dispatchOverview, getGraph, projectRoot);
	registerMcpTool(server, "shazam_lookup", dispatchLookup, getGraph, projectRoot);
	registerMcpTool(server, "shazam_impact", dispatchImpact, getGraph, projectRoot);
	registerMcpTool(server, "shazam_verify", dispatchVerify as DispatcherFn, getGraph, projectRoot);
	registerMcpTool(server, "shazam_changes", dispatchChanges, getGraph, projectRoot);
	registerMcpTool(server, "shazam_format", dispatchFormat as DispatcherFn, getGraph, projectRoot);
	registerMcpTool(server, "shazam_rename_symbol", dispatchRenameSymbol as DispatcherFn, getGraph, projectRoot);
}

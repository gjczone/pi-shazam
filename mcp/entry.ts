#!/usr/bin/env node
/**
 * pi-shazam MCP server — exposes codebase analysis tools via Model Context Protocol.
 *
 * Usage: npx pi-shazam-mcp
 *
 * Clients (Cursor, Claude Desktop, Windsurf, Qoder) launch this process
 * and communicate via stdio JSON-RPC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";
import { LspManager, detectProjectLanguages } from "../lsp/manager.js";
import { setLspManager } from "../tools/_context.js";
import { registerAllTools } from "./tools.js";

const PROJECT_ROOT = process.argv[2] || ".";

// Graph cache — uses scanProject's built-in incremental mtime detection.
// No TTL needed; scanProject already handles per-file change detection.
let cachedGraph: RepoGraph | null = null;

function getGraph(): RepoGraph {
	cachedGraph = scanProject(PROJECT_ROOT);
	return cachedGraph;
}

async function main(): Promise<void> {
	// Initialize LSP servers for richer analysis (hover, diagnostics, etc.)
	const lspManager = new LspManager(PROJECT_ROOT);
	const languages = detectProjectLanguages(PROJECT_ROOT);
	if (languages.length > 0) {
		try {
			await lspManager.initializeAll();
		} catch (err) {
			console.error("[pi-shazam mcp] lsp init failed:", err);
		}
	}

	const server = new McpServer({
		name: "pi-shazam",
		version: "0.12.0",
	});

	// Share LspManager with tools layer so LSP enrichment works in MCP mode
	setLspManager(lspManager);

	// Register all analysis tools with LSP support
	registerAllTools(server, getGraph, PROJECT_ROOT, lspManager);

	// Graceful shutdown on process exit
	const shutdown = async () => {
		try {
			await lspManager.shutdown();
		} catch {
			/* best effort */
		}
	};
	process.on("SIGTERM", () => {
		shutdown().finally(() => process.exit(0));
	});
	process.on("SIGINT", () => {
		shutdown().finally(() => process.exit(0));
	});

	// Start stdio transport
	const transport = new StdioServerTransport();
	transport.onclose = () => {
		lspManager.shutdown().catch(() => {});
	};
	process.stdin.on("end", () => {
		lspManager.shutdown().catch(() => {});
	});
	await server.connect(transport);
}

main().catch((err) => {
	console.error("pi-shazam MCP server failed to start:", err);
	process.exit(1);
});

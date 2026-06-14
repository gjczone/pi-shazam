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
import { registerAllTools } from "./tools.js";

const PROJECT_ROOT = process.argv[2] || ".";

// Graph cache with TTL — re-scans when stale so file edits during a
// session are reflected in analysis results (fixes #285).
let cachedGraph: RepoGraph | null = null;
let graphTimestamp = 0;
const GRAPH_CACHE_TTL_MS = 30_000; // 30 seconds

function getGraph(): RepoGraph {
	const now = Date.now();
	if (!cachedGraph || now - graphTimestamp > GRAPH_CACHE_TTL_MS) {
		cachedGraph = scanProject(PROJECT_ROOT);
		graphTimestamp = now;
	}
	return cachedGraph;
}

async function main(): Promise<void> {
	const server = new McpServer({
		name: "pi-shazam",
		version: "0.10.3",
	});

	// Register all analysis tools (graph is lazily scanned on first call)
	registerAllTools(server, getGraph, PROJECT_ROOT);

	// Start stdio transport
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("pi-shazam MCP server failed to start:", err);
	process.exit(1);
});

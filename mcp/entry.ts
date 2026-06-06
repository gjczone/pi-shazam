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
import { registerAllTools } from "./tools.js";

const PROJECT_ROOT = process.argv[2] || ".";

async function main(): Promise<void> {
	const server = new McpServer({
		name: "pi-shazam",
		version: "0.2.0",
	});

	// Scan project (builds symbol graph, may take 1-5s for large projects)
	const graph = scanProject(PROJECT_ROOT);

	// Register all 13 analysis tools
	registerAllTools(server, graph, PROJECT_ROOT);

	// Start stdio transport
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("pi-shazam MCP server failed to start:", err);
	process.exit(1);
});

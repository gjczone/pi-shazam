#!/usr/bin/env node
/**
 * pi-shazam MCP server -- exposes codebase analysis tools via Model Context Protocol.
 *
 * Usage: npx pi-shazam-mcp
 *
 * Clients (Cursor, Claude Desktop, Windsurf, Qoder) launch this process
 * and communicate via stdio JSON-RPC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";
import { LspManager, detectProjectLanguages } from "../lsp/manager.js";
import { setLspManager } from "../tools/_context.js";
import { registerAllTools } from "./tools.js";

const PROJECT_ROOT = resolve(process.argv[2] || ".");
// Validate PROJECT_ROOT is within allowed directories
try {
	const realRoot = realpathSync(PROJECT_ROOT);
	const homeDir = process.env.HOME || "/home";
	if (!realRoot.startsWith(homeDir) && realRoot !== "/") {
		console.error("[pi-shazam mcp] PROJECT_ROOT must be within user home directory");
		process.exit(1);
	}
} catch {
	console.error("[pi-shazam mcp] Invalid PROJECT_ROOT path");
	process.exit(1);
}

// Read version from package.json to keep it in sync automatically
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "..", "package.json");
let VERSION = "0.0.0";
try {
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	VERSION = pkg.version || VERSION;
} catch {
	console.warn("[pi-shazam mcp] failed to read package.json version");
	// Fallback -- version will be inaccurate but MCP will still work
}

// Graph cache -- uses scanProject's built-in incremental mtime detection.
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
		version: VERSION,
	});

	// Share LspManager with tools layer so LSP enrichment works in MCP mode
	await setLspManager(lspManager);

	// Register all analysis tools with LSP support
	registerAllTools(server, getGraph, PROJECT_ROOT, lspManager);

	// Graceful shutdown on process exit (with reentrancy guard)
	let _shuttingDown = false;
	const shutdown = async () => {
		if (_shuttingDown) return;
		_shuttingDown = true;
		try {
			await lspManager.shutdown();
		} catch {
			console.warn("[pi-shazam mcp] shutdown: lspManager.shutdown failed");
			/* best effort */
		}
	};
	const onSignal = async (): Promise<void> => {
		await shutdown();
		process.exit(0);
	};
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	// Start stdio transport
	const transport = new StdioServerTransport();
	transport.onclose = () => {
		shutdown().catch(() => {});
	};
	process.stdin.on("end", () => {
		shutdown().catch(() => {});
	});
	await server.connect(transport);
}

main().catch((err) => {
	console.error("pi-shazam MCP server failed to start:", err);
	process.exit(1);
});

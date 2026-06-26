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
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanProject, setProjectRoot } from "../core/scanner.js";
import { _logWarn } from "../core/output.js";
import type { RepoGraph } from "../core/graph.js";
import { LspManager, detectProjectLanguages } from "../lsp/manager.js";
import { setLspManager } from "../tools/_context.js";
import { registerAllTools } from "./tools.js";

/**
 * Validate that PROJECT_ROOT is a real directory.
 *
 * #465: previously the MCP server rejected any PROJECT_ROOT not under $HOME,
 * breaking container/CI deployment where projects live under /workspace,
 * /srv, /opt, /code, etc. The home-prefix restriction has been replaced
 * with an existence + directory check that accepts any valid directory.
 *
 * If an opt-in home-only mode is desired, set PI_SHAZAM_HOME_ONLY=1.
 * Returns { ok: true } on success, or { ok: false, error } on failure.
 */
export function validateProjectRoot(root: string): { ok: boolean; error?: string } {
	try {
		const realRoot = realpathSync(root);
		const stats = statSync(realRoot);
		if (!stats.isDirectory()) {
			return { ok: false, error: "PROJECT_ROOT must be a directory" };
		}
		// #465: optional home-only hardening for environments that want it.
		// Defaults to off so container/CI topologies (/workspace, /srv, /opt)
		// work out of the box.
		if (process.env.PI_SHAZAM_HOME_ONLY === "1") {
			const homeDir = process.env.HOME || "/home";
			const isUnderHome = realRoot === homeDir || realRoot.startsWith(homeDir + "/");
			if (!isUnderHome) {
				return { ok: false, error: "PROJECT_ROOT must be within user home directory (PI_SHAZAM_HOME_ONLY=1)" };
			}
		}
		return { ok: true };
	} catch {
		return { ok: false, error: "Invalid PROJECT_ROOT path" };
	}
}

const PROJECT_ROOT = resolve(process.argv[2] || ".");
// #464/#465: validate PROJECT_ROOT exists and is a directory, then propagate
// it to the scanner override so getEffectiveRoot() returns PROJECT_ROOT.
const rootValidation = validateProjectRoot(PROJECT_ROOT);
if (!rootValidation.ok) {
	console.error(`[pi-shazam mcp] ${rootValidation.error}`);
	process.exit(1);
}
// #464: propagate the explicit project-root argument to the scanner override
// so getEffectiveRoot() returns PROJECT_ROOT inside MCP executors. Without
// this, factory-injected params.project and buildEnvelope project fields
// would fall back to process.cwd(), diverging from PROJECT_ROOT used by
// scanProject and the LSP manager.

setProjectRoot(PROJECT_ROOT);

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
			_logWarn("lspInit", "lsp init failed", err);
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

// Guard: only run main() when this module is the entry point (not when
// imported by tests). This allows tests to import validateProjectRoot
// without triggering the MCP server startup sequence.
const isMainModule =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	main().catch((err) => {
		_logWarn("main", "MCP server failed to start", err);
		process.exit(1);
	});
}

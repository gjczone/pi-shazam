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
export function validateProjectRoot(root: string): { ok: boolean; error?: string; realRoot?: string } {
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
			// #586: On Windows, HOME is not set by default in cmd/PowerShell.
			// USERPROFILE is the Windows equivalent. Fall back to USERPROFILE
			// before the hardcoded "/home" (which does not exist on Windows).
			const homeDir = process.env.HOME || process.env.USERPROFILE || (process.platform === "win32" ? "" : "/home");
			const isUnderHome = realRoot === homeDir || realRoot.startsWith(homeDir + "/");
			if (!isUnderHome) {
				return { ok: false, error: "PROJECT_ROOT must be within user home directory (PI_SHAZAM_HOME_ONLY=1)" };
			}
		}
		return { ok: true, realRoot };
	} catch (err) {
		return { ok: false, error: `Invalid PROJECT_ROOT path: ${err instanceof Error ? err.message : String(err)}` };
	}
}

// Priority: CLI arg > PI_SHAZAM_PROJECT_ROOT env > PWD env > cwd
const rawRoot = resolve(process.argv[2] || process.env.PI_SHAZAM_PROJECT_ROOT || process.env.PWD || ".");
// #464/#465: validate PROJECT_ROOT exists and is a directory, then propagate
// it to the scanner override so getEffectiveRoot() returns PROJECT_ROOT.
const rootValidation = validateProjectRoot(rawRoot);
if (!rootValidation.ok) {
	console.error(`[pi-shazam mcp] ${rootValidation.error}`);
	process.exit(1);
}
// #464: propagate the explicit project-root argument to the scanner override
// so getEffectiveRoot() returns PROJECT_ROOT inside MCP executors. Without
// this, factory-injected params.project and buildEnvelope project fields
// would fall back to process.cwd(), diverging from PROJECT_ROOT used by
// scanProject and the LSP manager.
// #570: use the realpath-resolved root from validateProjectRoot to avoid
// path mismatches with LSP (symlink paths vs resolved paths).
const PROJECT_ROOT = rootValidation.realRoot!;

setProjectRoot(PROJECT_ROOT);

// Read version from package.json to keep it in sync automatically.
// #485: entry.js lives at dist/mcp/ (compiled) or mcp/ (vitest source).
// Search upward to handle both layouts.
const __dirname = dirname(fileURLToPath(import.meta.url));
let VERSION = "0.0.0";
for (const candidate of [resolve(__dirname, "..", "..", "package.json"), resolve(__dirname, "..", "package.json")]) {
	try {
		const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
		if (pkg.version) {
			VERSION = pkg.version;
			break;
		}
	} catch (err) {
		_logWarn("entry", `package.json not readable at ${candidate}`, err);
	}
}
if (VERSION === "0.0.0") {
	_logWarn("entry", "failed to read package.json version");
}

// Graph cache -- uses scanProject's built-in incremental mtime detection.
// No TTL needed; scanProject already handles per-file change detection.
let cachedGraph: RepoGraph | null = null;

export function getGraph(): RepoGraph {
	try {
		cachedGraph = scanProject(PROJECT_ROOT);
	} catch (err) {
		_logWarn("getGraph", "scanProject failed, falling back to cached graph", err);
		if (!cachedGraph) throw err;
	}
	return cachedGraph!;
}

async function main(): Promise<void> {
	// Initialize LSP servers for richer analysis (hover, diagnostics, etc.)
	const lspManager = new LspManager(PROJECT_ROOT);
	// Scan project early so we can derive languages from the graph
	// instead of walking the directory twice (issue #571 step 7).
	const graph = scanProject(PROJECT_ROOT);
	cachedGraph = graph;
	const languages = detectProjectLanguages(PROJECT_ROOT, 5000, graph.fileSymbols.keys());
	// #600: Track whether LSP init succeeded so we can pass null to
	// setLspManager when it fails, activating the tree-sitter-only
	// fallback branches in tools.
	let lspOk = languages.length > 0;
	if (lspOk) {
		try {
			await lspManager.initializeAll();
		} catch (err) {
			_logWarn("lspInit", "lsp init failed", err);
			lspOk = false;
		}
	}

	const server = new McpServer({
		name: "pi-shazam",
		version: VERSION,
	});

	// Share LspManager with tools layer so LSP enrichment works in MCP mode.
	// Pass null on init failure so tool fallback branches activate (#600).
	await setLspManager(lspOk ? lspManager : null);

	// Register all analysis tools
	registerAllTools(server, getGraph, PROJECT_ROOT);

	// Graceful shutdown on process exit (with reentrancy guard)
	let _shuttingDown = false;
	const shutdown = async () => {
		if (_shuttingDown) return;
		_shuttingDown = true;
		try {
			await lspManager.shutdown();
		} catch (err) {
			_logWarn("shutdown", "lspManager.shutdown failed", err);
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
		shutdown().catch((err) => _logWarn("mcpShutdown", "shutdown failed on transport close", err));
	};
	process.stdin.on("end", () => {
		shutdown().catch((err) => _logWarn("mcpShutdown", "shutdown failed on stdin end", err));
	});
	await server.connect(transport);
}

// Guard: only run main() when this module is the entry point (not when
// imported by tests). This allows tests to import validateProjectRoot
// without triggering the MCP server startup sequence.
// #485: npm/npx always create symlinks in .bin/ directories, so
// process.argv[1] (symlink path) never equals import.meta.url (resolved
// file URL). Resolve symlinks via realpathSync before comparing.
const isMainModule = (() => {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
	} catch (err) {
		_logWarn("entry", "realpath comparison failed, falling back to URL comparison", err);
		return import.meta.url === pathToFileURL(process.argv[1]).href;
	}
})();
if (isMainModule) {
	main().catch((err) => {
		_logWarn("main", "MCP server failed to start", err);
		process.exit(1);
	});
}

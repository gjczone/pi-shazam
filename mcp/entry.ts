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
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanProject, setProjectRoot } from "../core/scanner.js";
import { normalizePathInput, isHomeDirectory } from "../core/path-utils.js";
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
	// #673: normalize Git-Bash /c/foo and WSL /mnt/c/foo to C:\foo before
	// realpathSync so Node can resolve the path on Windows.
	const normalizedRoot = normalizePathInput(root);
	try {
		const realRoot = realpathSync(normalizedRoot);
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
			// Normalize both sides so the containment check is platform-agnostic:
			// on Windows realRoot uses backslashes (C:\Users\me\project) while
			// homeDir + "/" uses forward slashes, so the startsWith check must
			// compare resolved, separator-normalized paths (fix #668).
			const homeResolved = resolve(homeDir);
			const isUnderHome = realRoot === homeResolved || realRoot.startsWith(homeResolved + sep);
			if (!isUnderHome) {
				return { ok: false, error: "PROJECT_ROOT must be within user home directory (PI_SHAZAM_HOME_ONLY=1)" };
			}
		}
		// Issue #720: refuse to scan the user's home directory by default.
		// Home trees are 10-100 GB and tens of thousands of directories --
		// a full walk blocks MCP startup past the 30 s default timeout and
		// burns CPU on non-project content. Users who genuinely want to
		// scan a project under $HOME can opt in with PI_SHAZAM_ALLOW_HOME=1.
		// The PI_SHAZAM_HOME_ONLY branch above (#465) is an explicit opt-in
		// to home scanning, so it implicitly satisfies the home guard too.
		const homeAllowed = process.env.PI_SHAZAM_ALLOW_HOME === "1" || process.env.PI_SHAZAM_HOME_ONLY === "1";
		if (!homeAllowed && isHomeDirectory(realRoot)) {
			return {
				ok: false,
				error:
					"Refusing to scan home directory. Set PI_SHAZAM_ALLOW_HOME=1 to opt in, " +
					"or pass a project root outside $HOME.",
			};
		}
		return { ok: true, realRoot };
	} catch (err) {
		return { ok: false, error: `Invalid PROJECT_ROOT path: ${err instanceof Error ? err.message : String(err)}` };
	}
}

// Priority: CLI arg > PI_SHAZAM_PROJECT_ROOT env > PWD env > cwd
const rawRoot = resolve(process.argv[2] || process.env.PI_SHAZAM_PROJECT_ROOT || process.env.PWD || ".");
// #464/#465: validate PROJECT_ROOT exists and is a directory.
const rootValidation = validateProjectRoot(rawRoot);
// #676: do NOT call process.exit at module load. Tests import this module
// (e.g. to call validateProjectRoot / getGraph) under a vitest worker where
// process.argv[2] is a vitest argument, not a project root. Exiting here would
// kill the worker and cascade-fail every later test in the same file. The exit
// is deferred to main() (see below) so only the real MCP entry point aborts on
// a bad root. PROJECT_ROOT still resolves to a usable value at load time so
// getGraph() and other exports work when imported by tests.
const PROJECT_ROOT = rootValidation.ok ? rootValidation.realRoot! : rawRoot;

// Issue #632: the scanner excludes test files from the default graph to
// prevent ~56% noise in pi-shazam-sized projects. We do NOT pass
// `includeTests` explicitly here because `scanProject()` re-reads the
// `PI_SHAZAM_INCLUDE_TESTS` env var on every call (see
// `core/scanner.ts:shouldIncludeTestsFromEnv`). Freezing the decision at
// module load would break env-var changes after MCP startup -- which is
// a documented test ergonomics requirement.

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
		// ENOENT is expected on the first candidate when entry.js sits at
		// dist/mcp/ (the second candidate ../package.json will succeed).
		// Suppress the stderr line; only surface real parse errors. Issue
		// #632 UX principle: negative probes must stay silent.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") continue;
		_logWarn("entry", `package.json not readable at ${candidate}`, err);
	}
}
if (VERSION === "0.0.0") {
	_logWarn("entry", "failed to read package.json version");
}

// Graph cache -- uses scanProject's built-in incremental mtime detection
// for per-file change detection. For long-lived MCP processes the cached
// graph (~500MB-1GB for large projects) is held in module memory otherwise
// forever; the TTL below releases it after a configurable idle period so
// the next access rebuilds from the persistent disk cache (#626).
//
// Set PI_SHAZAM_GRAPH_TTL_MS=0 to disable (always retain the cache).
// Default: 10 minutes.
const DEFAULT_GRAPH_TTL_MS = 10 * 60 * 1000;
const GRAPH_TTL_MS = (() => {
	const raw = process.env.PI_SHAZAM_GRAPH_TTL_MS;
	if (raw === undefined || raw === "") return DEFAULT_GRAPH_TTL_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_GRAPH_TTL_MS;
	return parsed;
})();
let cachedGraph: RepoGraph | null = null;
let lastGraphAccess = 0;
// Re-entrancy guard mirroring scanner.ts `_scanning`. getGraph is synchronous
// and scanProject is synchronous, so two calls cannot truly interleave — but a
// re-entrant getGraph (e.g. from a hook firing during a scan) must not trigger
// a duplicate scanProject. While a build is in progress we return the graph we
// already have.
let graphBuilding = false;

export function getGraph(): RepoGraph {
	const now = Date.now();
	// Release the cached graph when the TTL has elapsed since the last
	// access. The next scanProject() call rebuilds from the persistent
	// disk cache (fast, mtime-based) and assigns a fresh graph to
	// cachedGraph, so the old graph becomes garbage once the caller of
	// getGraph() drops its reference. CLI one-shot mode is unaffected
	// because the process exits before the TTL elapses.
	if (cachedGraph !== null && GRAPH_TTL_MS > 0 && lastGraphAccess > 0 && now - lastGraphAccess > GRAPH_TTL_MS) {
		cachedGraph = null;
	}
	lastGraphAccess = now;
	if (cachedGraph !== null) {
		return cachedGraph;
	}
	if (graphBuilding) {
		if (cachedGraph === null) {
			throw new Error("Graph build already in progress but no cached graph available");
		}
		return cachedGraph;
	}
	try {
		graphBuilding = true;
		// #676: when imported by tests, PROJECT_ROOT is not a validated MCP
		// root (module load no longer exits), so fall back to cwd — the real
		// project under test. In the running MCP server PROJECT_ROOT is always
		// valid (main() guards it), so this branch never triggers there.
		cachedGraph = scanProject(rootValidation.ok ? PROJECT_ROOT : process.cwd());
	} catch (err) {
		_logWarn("getGraph", "scanProject failed, falling back to cached graph", err);
		if (!cachedGraph) throw err;
	} finally {
		graphBuilding = false;
	}
	if (cachedGraph === null) {
		throw new Error("Failed to build graph and no cached graph available");
	}
	return cachedGraph;
}

async function main(): Promise<void> {
	// #676: abort only when this module is the actual MCP entry point.
	// (Module load no longer exits — see rootValidation above — so vitest
	// imports stay alive. Here, with a bad PROJECT_ROOT, we still refuse to
	// start the server, preserving the original fail-closed behavior.)
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
	setProjectRoot(PROJECT_ROOT);

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
	// #757: shared shutdown-and-exit helper. Every shutdown trigger (transport
	// close, stdin end/error/close, signals) must eventually call process.exit(0)
	// after shutdown() completes. Without this, Windows MCP processes linger as
	// zombies when the client disconnects abruptly — SIGTERM is not reliably
	// delivered on Windows, so the stdin/transport handlers are the only path to
	// cleanup. The _shuttingDown latch inside shutdown() makes multiple triggers
	// safe (only the first one runs the full shutdown).
	const shutdownAndExit = (reason: string) => {
		shutdown()
			.catch((err) => _logWarn("mcpShutdown", `shutdown failed on ${reason}`, err))
			.finally(() => {
				// #599: defer exit so the event loop flushes pending I/O
				// from lspManager.shutdown() (LSP shutdown/exit JSON-RPC).
				setImmediate(() => process.exit(0));
			});
	};
	const onSignal = async (): Promise<void> => {
		await shutdown();
		// #599: Defer process.exit via setImmediate so the event loop
		// flushes pending I/O from lspManager.shutdown() (LSP shutdown/exit
		// JSON-RPC round-trips) before the process terminates. Without this,
		// process.exit(0) tears down mid-handshake, leaving language-server
		// child processes orphaned.
		setImmediate(() => process.exit(0));
	};
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	// Start stdio transport
	const transport = new StdioServerTransport();
	transport.onclose = () => shutdownAndExit("transport close");
	// #608: Windows-reliable shutdown triggers. On Windows, when an
	// MCP client exits abruptly without orderly stdin close, the OS
	// delivers a pipe 'error' or 'close' event instead of 'end'.
	// SIGTERM is also not reliably delivered to Windows processes.
	// These additional handlers ensure lspManager.shutdown() runs
	// and LSP child processes are cleaned up regardless of platform.
	// All handlers are idempotent (protected by _shuttingDown latch).
	process.stdin.on("end", () => shutdownAndExit("stdin end"));
	process.stdin.on("error", (e) => {
		_logWarn("mcpShutdown", "stdin error, initiating shutdown", e);
		shutdownAndExit("stdin error");
	});
	process.stdin.on("close", () => shutdownAndExit("stdin close"));
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

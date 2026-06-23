/**
 * pi-shazam lsp/manager -- Language server process lifecycle management.
 *
 * Detects project languages, spawns LSP servers on demand,
 * handles health checks, restarts, and graceful shutdown.
 * Supports multiple detection sources: project-local, PATH, and user home.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { homedir } from "node:os";
import { LspClient } from "./client.js";
import type { LspDiagnostic, LspLocation } from "./client.js";
import { LSP_SERVER_SPECS, languageForSuffix, lspTimeoutFor } from "./servers.js";
import { SKIP_DIRS } from "../core/filter.js";

// -- Types --------------------------------------------------------------------

export interface LspServerInfo {
	language: string;
	serverName: string;
	client: LspClient;
	command: readonly string[];
	workspaceRoot: string;
	source: "project" | "path" | "user";
}

export interface LspServerDetection {
	language: string;
	serverName: string;
	status: "available" | "missing";
	command: string[];
	source: string;
	workspaceRoot: string;
	reason?: string;
}

export interface LspRunResult {
	server: string;
	language: string;
	status: "ok" | "skipped" | "timeout" | "failed";
	diagnostics: LspDiagnostic[];
	definitions: LspLocation[];
	references: LspLocation[];
	command: string[];
	workspaceRoot: string;
	reason?: string;
	durationMs: number;
}

// -- Project language detection -----------------------------------------------

/**
 * Check if a path contains any skip directory segment.
 * Used to avoid feeding vendored/generated files to LSP.
 */
export function shouldSkipPath(filePath: string): boolean {
	const segments = filePath.split("/");
	for (const seg of segments) {
		if (SKIP_DIRS.has(seg)) return true;
	}
	return false;
}

/**
 * Walk project root and detect languages from file extensions.
 */
export function detectProjectLanguages(projectRoot: string, maxFiles: number = 2000): string[] {
	const langs = new Set<string>();
	let seen = 0;
	const MAX_DEPTH = 50;
	const visited = new Map<string, true>();

	function walk(dir: string, depth: number = 0): void {
		if (seen >= maxFiles || depth > MAX_DEPTH) return;
		// Cycle detection via realpath
		let real: string;
		try {
			// Use resolve to normalize; rely on visited map for cycle detection
			real = resolve(dir);
		} catch (err) {
			console.warn(`[pi-shazam] detectProjectLanguages: resolve failed for ${dir}`, err);
			return;
		}
		if (visited.has(real)) return;
		visited.set(real, true);

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (e) {
			// Log non-permission errors (permission errors are common in node_modules, .git, etc.)
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "EACCES" && err.code !== "EPERM") {
				console.warn(`[pi-shazam] detectProjectLanguages: readdirSync failed for ${dir}: ${err.message}`);
			}
			return;
		}
		for (const entry of entries) {
			if (seen >= maxFiles) return;
			if (SKIP_DIRS.has(entry)) continue;
			const fullPath = join(dir, entry!);
			let st;
			try {
				st = statSync(fullPath);
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code !== "EACCES" && err.code !== "EPERM" && err.code !== "ENOENT") {
					console.warn(`[pi-shazam] detectProjectLanguages: statSync failed for ${fullPath}: ${err.message}`);
				}
				continue;
			}
			if (st.isDirectory()) {
				walk(fullPath, depth + 1);
			} else if (st.isFile()) {
				seen++;
				const ext = entry!.substring(entry!.lastIndexOf(".")).toLowerCase();
				const lang = languageForSuffix(ext);
				if (lang) langs.add(lang);
			}
		}
	}

	walk(resolve(projectRoot));
	return [...langs].sort();
}

// -- LSP server detection -----------------------------------------------------

/**
 * Find the LSP workspace root by walking up from a file path
 * looking for root markers.
 */
function detectWorkspaceRoot(projectRoot: string, filePath: string | null, language: string): string {
	const root = resolve(projectRoot);

	// Ensure filePath is within project root; prevent escaping to parent directories
	if (filePath) {
		const resolvedFile = resolve(filePath);
		if (!resolvedFile.startsWith(root + "/") && resolvedFile !== root) {
			return root;
		}
	}

	const specs = LSP_SERVER_SPECS.filter((s) => s.language === language);
	const markers = new Set<string>();
	for (const spec of specs) {
		for (const m of spec.rootMarkers) {
			markers.add(m);
		}
	}

	let current = filePath ? resolve(filePath) : root;
	if (!existsSync(current)) current = root;

	// Start from file's directory
	if (existsSync(current) && statSync(current).isFile()) {
		current = join(current, "..");
	}
	current = resolve(current);

	// Maximum directory walk depth to prevent infinite loops on systems
	// with symlinks, mount points, or unconventional layouts (fixes #98).
	const MAX_DEPTH = 50;
	let depth = 0;
	while (depth < MAX_DEPTH) {
		depth++;
		for (const marker of markers) {
			if (existsSync(join(current, marker))) {
				return current;
			}
		}
		// Check if we've reached or passed the project root
		const parent = resolve(current, "..");
		if (current === parent || parent === root) {
			if (current !== root) {
				// Check root itself
				for (const marker of markers) {
					if (existsSync(join(root, marker))) {
						return root;
					}
				}
			}
			break;
		}
		current = parent;
	}

	return root;
}

// -- Executable search --------------------------------------------------------

function isExecutable(filePath: string): boolean {
	try {
		const st = statSync(filePath);
		if (!st.isFile()) return false;
		if (process.platform === "win32") {
			// On Windows, check for executable extensions
			const lower = filePath.toLowerCase();
			return lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat");
		}
		// On POSIX, check the executable permission bit
		// eslint-disable-next-line no-bitwise
		return (st.mode & 0o111) !== 0;
	} catch (err) {
		console.warn(`[pi-shazam] isExecutable: statSync failed for ${filePath}`, err);
		return false;
	}
}

const SAFE_PATH_DIRS = new Set([
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/local/sbin",
	"/usr/sbin",
	"/sbin",
	"/opt/homebrew/bin",
	"/snap/bin",
]);

function findInPath(command: string): string | null {
	const pathEnv = process.env.PATH ?? "";
	const dirs = pathEnv.split(delimiter);
	for (const dir of dirs) {
		if (!SAFE_PATH_DIRS.has(dir)) continue; // only search trusted directories
		const candidate = join(dir, command);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

function trustedUserCandidates(commandName: string): string[] {
	const home = homedir();
	const candidates: string[] = [
		join(home, ".local", "bin", commandName),
		join(home, ".npm-global", "bin", commandName),
		join(home, ".cargo", "bin", commandName),
		join(home, "go", "bin", commandName),
		join(home, ".bun", "bin", commandName),
		join(home, ".yarn", "bin", commandName),
		join(home, ".config", "yarn", "global", "node_modules", ".bin", commandName),
		join(home, ".local", "share", "pnpm", commandName),
		join(home, ".local", "share", "nvim", "mason", "bin", commandName),
	];
	// Return all matching executables, not just the first (fixes for-of with immediate return)
	const results: string[] = [];
	for (const candidate of candidates) {
		if (isExecutable(candidate)) {
			results.push(candidate);
		}
	}
	return results;
}

// -- Detection ----------------------------------------------------------------

export function detectLspServer(projectRoot: string, language: string, filePath?: string | null): LspServerDetection {
	const root = resolve(projectRoot);
	const workspaceRoot = detectWorkspaceRoot(root, filePath ?? null, language);
	const specs = LSP_SERVER_SPECS.filter((s) => s.language === language);

	if (specs.length === 0) {
		return {
			language,
			serverName: "",
			status: "missing",
			command: [],
			source: "",
			workspaceRoot: root,
			reason: "unsupported language",
		};
	}

	for (const spec of specs) {
		// Check project-relative candidates first
		if (spec.projectRelativeCandidates) {
			for (const candidate of spec.projectRelativeCandidates) {
				const fullPath = join(workspaceRoot, candidate);
				if (isExecutable(fullPath)) {
					return {
						language,
						serverName: spec.serverName,
						status: "available",
						command: [fullPath, ...spec.args],
						source: "project",
						workspaceRoot,
					};
				}
			}
		}

		// Check PATH
		for (const cmdName of spec.commandNames) {
			const resolved = findInPath(cmdName);
			if (resolved) {
				return {
					language,
					serverName: spec.serverName,
					status: "available",
					command: [resolved, ...spec.args],
					source: "path",
					workspaceRoot,
				};
			}

			// Check user directories (return first match only)
			const userCandidates = trustedUserCandidates(cmdName);
			if (userCandidates.length > 0) {
				return {
					language,
					serverName: spec.serverName,
					status: "available",
					command: [userCandidates[0]!, ...spec.args],
					source: "user",
					workspaceRoot,
				};
			}
		}
	}

	return {
		language,
		serverName: specs[0]!.serverName,
		status: "missing",
		command: [],
		source: "",
		workspaceRoot,
		reason: "LSP server executable not found",
	};
}

// -- LspManager ---------------------------------------------------------------

export class LspManager {
	private projectRoot: string;
	private servers = new Map<string, LspServerInfo>();
	private log: (msg: string) => void;
	// Track opened file paths per language for re-open after server crash
	private _openedFilePaths = new Map<string, Set<string>>();
	private _initPromises = new Map<string, Promise<LspServerInfo | null>>();
	private _restartBudget = new Map<string, { failures: number; nextRetryAt: number }>();
	private _shuttingDown = false;

	constructor(projectRoot: string, log?: (msg: string) => void) {
		this.projectRoot = resolve(projectRoot);
		this.log = log ?? (() => {});
	}

	/**
	 * Update the project root after construction. Used by the extension
	 * entry when Pi's detected project directory (ctx.cwd) differs from
	 * the process CWD at load time (issue #241).
	 *
	 * No-op if the resolved path is unchanged.
	 */
	setProjectRoot(newRoot: string): void {
		const resolved = resolve(newRoot);
		if (resolved !== this.projectRoot) {
			this.projectRoot = resolved;
			this.log?.(`Project root updated to ${this.projectRoot}`);
		}
	}

	// -- Detection --------------------------------------------------------------

	/**
	 * Auto-detect languages in the project and return what was found.
	 */
	detectLanguages(): string[] {
		return detectProjectLanguages(this.projectRoot);
	}

	/**
	 * Detect LSP server for a specific language.
	 */
	detectServer(language: string, filePath?: string): LspServerDetection {
		return detectLspServer(this.projectRoot, language, filePath ?? null);
	}

	// -- Server management ------------------------------------------------------

	/**
	 * Get the LSP client for a given file, creating one if needed.
	 * Returns null if no LSP server is available for the file's language.
	 */
	async getServerForFile(filePath: string): Promise<LspServerInfo | null> {
		// Skip vendored / generated / cache directories
		if (shouldSkipPath(filePath)) return null;

		// Reject paths outside project root
		const absPath = resolve(this.projectRoot, filePath);
		if (!absPath.startsWith(resolve(this.projectRoot) + "/") && absPath !== resolve(this.projectRoot)) {
			return null;
		}

		const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
		const language = languageForSuffix(ext);
		if (!language) return null;

		return this.getServerForLanguage(language, filePath);
	}

	/**
	 * Get or create an LSP client for a language.
	 */
	async getServerForLanguage(language: string, filePath?: string, signal?: AbortSignal): Promise<LspServerInfo | null> {
		if (this._shuttingDown) return null;

		// Honor restart budget: if server previously failed, wait for backoff
		const budget = this._restartBudget.get(language);
		if (budget && Date.now() < budget.nextRetryAt) return null;

		// Deduplicate concurrent initialization for the same language
		const existingInit = this._initPromises.get(language);
		if (existingInit) return existingInit;

		const initPromise = this._initServerForLanguage(language, filePath, signal);
		this._initPromises.set(language, initPromise);
		return initPromise;
	}

	private async _initServerForLanguage(
		language: string,
		filePath?: string,
		signal?: AbortSignal,
	): Promise<LspServerInfo | null> {
		try {
			// Return existing server if already initialized
			const existing = this.servers.get(language);
			if (existing && existing.client.isInitialized()) return existing;
			// Remove dead client so re-detection can happen
			if (existing) {
				this.servers.delete(language);
				// Close the old client to release resources
				await existing.client.close().catch((err) => this.log(`close old client for ${language} failed: ${err}`));
			}

			// Detect and spawn
			const detection = detectLspServer(this.projectRoot, language, filePath ?? null);

			if (detection.status !== "available" || detection.command.length === 0) {
				this.log(`LSP server not available for ${language}: ${detection.reason ?? "not found"}`);
				return null;
			}

			// Check abort signal before expensive init
			if (signal?.aborted) return null;

			const timeout = lspTimeoutFor(language);
			const client = new LspClient(detection.command, detection.workspaceRoot, timeout, this.log);

			try {
				client.start();
				// Initialize immediately so tools get a ready client
				await client.initialize(signal);
				// Check if cancelled during init
				if (signal?.aborted) {
					await client.close().catch((err) => this.log(`close on abort for ${language} failed: ${err}`));
					return null;
				}
				// Successful init -- reset restart budget
				this._restartBudget.delete(language);
			} catch (err) {
				this.log(`Failed to start/initialize LSP for ${language}: ${err}`);
				// Track failures and set backoff
				const cur = this._restartBudget.get(language) ?? { failures: 0, nextRetryAt: 0 };
				cur.failures++;
				cur.nextRetryAt = Date.now() + Math.min(2 ** cur.failures * 1000, 60_000);
				this._restartBudget.set(language, cur);
				await client.close().catch((err) => this.log(`close on failure for ${language} failed: ${err}`));
				return null;
			}

			const info: LspServerInfo = {
				language,
				serverName: detection.serverName,
				client,
				command: detection.command,
				workspaceRoot: detection.workspaceRoot,
				source: detection.source as LspServerInfo["source"],
			};

			this.servers.set(language, info);

			// Re-open previously opened files after server crash/reconnection
			const prevOpened = this._openedFilePaths.get(language);
			if (prevOpened && prevOpened.size > 0) {
				// Read all files in parallel, then send didOpen in parallel
				const entries = [...prevOpened];
				const readResults = await Promise.allSettled(
					entries.map(async (filePath) => {
						const absPath = resolve(detection.workspaceRoot, filePath);
						const content = await readFileAsync(absPath, "utf-8");
						return { filePath, content };
					}),
				);
				await Promise.allSettled(
					readResults.map(async (result) => {
						if (result.status === "fulfilled") {
							try {
								await client.didOpen(result.value.filePath, result.value.content);
							} catch (err) {
								console.warn(`[pi-shazam] _initServerForLanguage: re-open failed for ${result.value.filePath}`, err);
								prevOpened.delete(result.value.filePath);
							}
						} else {
							// File read failed -- likely deleted; remove from tracking
							const filePath = entries[readResults.indexOf(result)]!;
							console.warn(`[pi-shazam] _initServerForLanguage: read failed for ${filePath}`, result.reason);
							prevOpened.delete(filePath);
						}
					}),
				);
			}

			return info;
		} finally {
			this._initPromises.delete(language);
		}
	}

	/**
	 * Initialize all detected LSP servers.
	 */
	async initializeAll(signal?: AbortSignal): Promise<void> {
		// Reset the shutdown latch so LSP recovers after a prior shutdown()
		// (_shuttingDown is a one-way latch set by shutdown() -- without this
		// reset, getServerForLanguage returns null forever).
		this._shuttingDown = false;

		const languages = this.detectLanguages();

		const promises = languages.map(async (language) => {
			if (signal?.aborted) return;
			const info = await this.getServerForLanguage(language, undefined, signal);
			if (signal?.aborted) return;
			if (info) {
				this.log(`LSP initialized: ${language} (${info.serverName})`);
			}
		});

		await Promise.allSettled(promises);
	}

	/**
	 * Get all active LSP servers.
	 */
	getActiveServers(): LspServerInfo[] {
		return [...this.servers.values()];
	}

	/**
	 * Shutdown all LSP servers gracefully.
	 */
	/**
	 * Track a file as opened for a language (for crash recovery).
	 */
	trackOpenedFile(language: string, filePath: string): void {
		let paths = this._openedFilePaths.get(language);
		if (!paths) {
			paths = new Set();
			this._openedFilePaths.set(language, paths);
		}
		paths.add(filePath);
	}

	async shutdown(): Promise<void> {
		this._shuttingDown = true;
		// Snapshot entries before clearing the map to avoid mutation during iteration
		const snapshot = [...this.servers.entries()];
		this.servers.clear();
		this._openedFilePaths.clear();
		this._initPromises.clear();

		const SHUTDOWN_TIMEOUT_MS = 8000;

		const closePromises = snapshot.map(async ([language, info]) => {
			try {
				// Race client.close() against a timeout to prevent hung processes
				// from leaking. client.close() has its own internal timeouts, but
				// a stuck process can still cause indefinite hangs.
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					info.client.close(),
					new Promise<void>((_, reject) => {
						timer = setTimeout(() => reject(new Error("close timed out")), SHUTDOWN_TIMEOUT_MS);
					}),
				]);
				if (timer) clearTimeout(timer);
				this.log(`LSP shutdown: ${language}`);
			} catch (err) {
				this.log(`LSP shutdown error for ${language}: ${err}`);
			}
		});
		await Promise.allSettled(closePromises);
	}
}

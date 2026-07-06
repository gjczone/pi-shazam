/**
 * pi-shazam lsp/manager -- Language server process lifecycle management.
 *
 * Detects project languages, spawns LSP servers on demand,
 * handles health checks, restarts, and graceful shutdown.
 * Supports multiple detection sources: project-local, PATH, and user home.
 */

import { readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, delimiter, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { LspClient } from "./client.js";
import type { LspDiagnostic, LspLocation } from "./client.js";
import { LSP_SERVER_SPECS, languageForSuffix, lspTimeoutFor } from "./servers.js";
import { SKIP_DIRS } from "../core/filter.js";
import { readFileAdaptiveAsync } from "../core/encoding.js";
import { _logWarn } from "../core/output.js";

// -- Helpers ------------------------------------------------------------------

/**
 * #450: Cross-platform path-containment check.
 * Uses relative() instead of startsWith(root + "/") so it works
 * correctly on Windows where path.resolve returns backslash-separated paths.
 */
function isPathInRoot(filePath: string, root: string): boolean {
	const rel = relative(root, filePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

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
	// #596: Normalize backslashes to forward slashes so Windows path
	// strings (e.g. src\node_modules\foo.ts) match SKIP_DIRS segments.
	const segments = filePath.replace(/\\/g, "/").split("/");
	for (const seg of segments) {
		if (SKIP_DIRS.has(seg)) return true;
	}
	return false;
}

/**
 * Walk project root and detect languages from file extensions.
 * Checks root markers first for fast detection, then falls back to
 * deriving languages from file paths (when provided, e.g. from
 * graph.fileSymbols) or directory walk as a last resort.
 *
 * When filePaths is provided, languages are derived from file extensions
 * without walking the filesystem, eliminating the duplicate walk that
 * scanner's collectSourceFiles already performs (issue #571 step 7).
 *
 * @param projectRoot - Absolute path to the project root
 * @param maxFiles - Max files to scan during directory walk fallback
 * @param filePaths - Optional pre-collected file paths (e.g. from
 *   graph.fileSymbols.keys()). When provided, skips the directory walk.
 */
export function detectProjectLanguages(
	projectRoot: string,
	maxFiles: number = 5000,
	filePaths?: Iterable<string>,
): string[] {
	const langs = new Set<string>();
	const root = resolve(projectRoot);

	// Fast path: check root markers before doing a full directory walk.
	// This avoids missing languages in large projects where the file limit
	// might truncate the scan before encountering language-specific files.
	for (const spec of LSP_SERVER_SPECS) {
		for (const marker of spec.rootMarkers) {
			if (existsSync(join(root, marker))) {
				langs.add(spec.language);
				break;
			}
		}
	}

	// Derive languages from pre-collected file paths (e.g. graph.fileSymbols).
	// This eliminates the duplicate directory walk when a graph is available
	// (issue #571 step 7).
	if (filePaths) {
		for (const filePath of filePaths) {
			const dotIdx = filePath.lastIndexOf(".");
			if (dotIdx < 0) continue;
			const ext = filePath.substring(dotIdx).toLowerCase();
			const lang = languageForSuffix(ext);
			if (lang) langs.add(lang);
		}
		return [...langs].sort();
	}

	// Fallback: directory walk to detect languages from file extensions.
	let seen = 0;
	const MAX_DEPTH = 50;
	const visited = new Map<string, true>();

	function walk(dir: string, depth: number = 0): void {
		if (seen >= maxFiles || depth > MAX_DEPTH) return;
		let real: string;
		try {
			real = realpathSync(dir);
		} catch (err) {
			_logWarn("detectProjectLanguages", `realpath failed for ${dir}`, err);
			return;
		}
		if (visited.has(real)) return;
		visited.set(real, true);

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "EACCES" && err.code !== "EPERM") {
				_logWarn("detectProjectLanguages", `readdirSync failed for ${dir}`, err.message);
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
					_logWarn("detectProjectLanguages", `statSync failed for ${fullPath}`, err.message);
				}
				continue;
			}
			if (st.isDirectory()) {
				// #609: Resolve symlink targets before recursing to prevent
				// cascading walks into out-of-project directories. Skip entries
				// whose real path is outside projectRoot or whose resolved
				// basename matches a skip directory.
				let realTarget: string;
				try {
					realTarget = realpathSync(fullPath);
				} catch (_err) {
					// Broken symlink or inaccessible path — skip
					continue;
				}
				const realBase = realTarget.split(/[\\/]/).pop() ?? "";
				if (SKIP_DIRS.has(realBase)) continue;
				if (!isPathInRoot(realTarget, root)) continue;
				walk(fullPath, depth + 1);
			} else if (st.isFile()) {
				seen++;
				const ext = entry!.substring(entry!.lastIndexOf(".")).toLowerCase();
				const lang = languageForSuffix(ext);
				if (lang) langs.add(lang);
			}
		}
	}

	walk(root);
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
		// #450: Use isPathInRoot instead of startsWith for Windows compatibility
		if (!isPathInRoot(resolvedFile, root)) {
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
		// Never walk above projectRoot. When current has reached root (this
		// happens when filePath is null/inside root, or after walking up from
		// a deeper file), root markers were already checked above, so break.
		// The previous condition only broke on `current === parent || parent
		// === root`, so when current === root itself and root had no marker,
		// it set current = parent (above root) and escaped (#466).
		if (current === root) {
			break;
		}
		const parent = resolve(current, "..");
		// Filesystem root reached without finding a marker.
		if (current === parent) {
			break;
		}
		current = parent;
	}

	return root;
}

// -- Executable search --------------------------------------------------------

/**
 * Check if a file path points to an executable.
 *
 * On Windows, respects the PATHEXT environment variable for extension
 * recognition (issue #585). On POSIX, checks the executable permission bit.
 */
export function _isExecutable(filePath: string): boolean {
	try {
		const st = statSync(filePath);
		if (!st.isFile()) return false;
		if (process.platform === "win32") {
			// #585: Use PATHEXT to determine which extensions are executable.
			// Default to standard Windows executable extensions if PATHEXT is unset.
			const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS").toLowerCase();
			const exts = pathext
				.split(";")
				.map((e) => e.trim())
				.filter(Boolean);
			const lower = filePath.toLowerCase();
			return exts.some((ext) => lower.endsWith(ext));
		}
		// On POSIX, check the executable permission bit
		// eslint-disable-next-line no-bitwise
		return (st.mode & 0o111) !== 0;
	} catch (err) {
		// ENOENT is expected during optional LSP server discovery —
		// the binary simply isn't installed. Only warn on real errors
		// (permission denied, I/O error, etc.). See _logWarn JSDoc.
		if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
			_logWarn("isExecutable", `statSync failed for ${filePath}`, err);
		}
		return false;
	}
}

function isExecutable(filePath: string): boolean {
	return _isExecutable(filePath);
}

export const _SAFE_PATH_DIRS = new Set([
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/local/sbin",
	"/usr/sbin",
	"/sbin",
	"/opt/homebrew/bin",
	"/home/linuxbrew/.linuxbrew/bin",
	"/snap/bin",
]);

/**
 * Resolve bin directories for mainstream Node.js version managers (nvm, fnm, volta).
 *
 * These managers install global binaries into version-dependent directories that
 * cannot be hardcoded. Each exposes the active directory via a well-known env var.
 *
 * Only directories that actually exist on disk are returned; missing ones are
 * silently skipped (the env var may be stale from a previous session).
 */
const VERSION_MANAGER_ENV_VARS: Array<{ env: string; subPath?: string }> = [
	{ env: "NVM_BIN" },
	{ env: "FNM_MULTISHELL_PATH" },
	{ env: "FNM_DIR", subPath: "current/bin" },
	{ env: "VOLTA_HOME", subPath: "bin" },
	{ env: "MISE_DATA_DIR", subPath: "shims" },
	{ env: "ASDF_DATA_DIR", subPath: "shims" },
	{ env: "PYENV_ROOT", subPath: "shims" },
	{ env: "PNPM_HOME" },
	{ env: "PNPM_HOME", subPath: "bin" },
	{ env: "N_PREFIX", subPath: "bin" },
	{ env: "HOMEBREW_PREFIX", subPath: "bin" },
];

/**
 * Default install directories for version managers when their env var is not set.
 * These are checked as fallbacks so users relying on default paths also work.
 */
const DEFAULT_VERSION_MANAGER_DIRS: Array<{ base: string; subPath: string }> = [
	{ base: join(homedir(), ".local", "share", "mise"), subPath: "shims" },
	{ base: join(homedir(), ".asdf"), subPath: "shims" },
	{ base: join(homedir(), ".pyenv"), subPath: "shims" },
	{ base: join(homedir(), ".local", "share", "pnpm"), subPath: "" },
	{ base: join(homedir(), ".local", "share", "pnpm"), subPath: "bin" },
	{ base: join(homedir(), ".linuxbrew"), subPath: "bin" },
];

export function _getVersionManagerBinDirs(): string[] {
	const dirs: string[] = [];
	for (const { env, subPath } of VERSION_MANAGER_ENV_VARS) {
		const base = process.env[env];
		if (!base) continue;
		const dir = subPath ? join(base, subPath) : base;
		try {
			if (statSync(dir).isDirectory()) {
				dirs.push(dir);
			}
		} catch (err) {
			// Directory does not exist — skip silently for ENOENT, log unexpected errors
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				_logWarn("_getVersionManagerBinDirs", `stat failed for ${dir}`, err);
			}
		}
	}
	// Fallback: check default install directories when env var is not set
	for (const { base, subPath } of DEFAULT_VERSION_MANAGER_DIRS) {
		const dir = subPath ? join(base, subPath) : base;
		try {
			if (statSync(dir).isDirectory()) {
				dirs.push(dir);
			}
		} catch (err) {
			// Directory does not exist — skip silently for ENOENT, log unexpected errors
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				_logWarn("_getVersionManagerBinDirs", `stat failed for ${dir}`, err);
			}
		}
	}
	return dirs;
}

// Wire version-manager bin dirs into trusted paths at module init.
for (const dir of _getVersionManagerBinDirs()) {
	_SAFE_PATH_DIRS.add(dir);
}

function findInPath(command: string): string | null {
	const pathEnv = process.env.PATH ?? "";
	const dirs = pathEnv.split(delimiter);
	// #582: On win32, bypass SAFE_PATH_DIRS filtering. Windows PATH is already
	// user-scoped, and the POSIX-only SAFE_PATH_DIRS set blocks all LSP discovery.
	// On POSIX, keep the safety filter to avoid scanning system bin dirs.
	for (const dir of dirs) {
		if (process.platform !== "win32" && !_SAFE_PATH_DIRS.has(dir)) continue;
		const candidate = join(dir, command);
		if (isExecutable(candidate)) return candidate;
	}
	// #582: On win32, npm global installs create .cmd shims (e.g.,
	// typescript-language-server.cmd). #605: try the full PATHEXT list
	// (COM;EXE;BAT;CMD;VBS;JS) so that .exe servers (gopls.exe,
	// rust-analyzer.exe) and .bat shims are discoverable through PATH.
	if (process.platform === "win32" && !command.includes(".")) {
		const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS").toLowerCase().split(";").filter(Boolean);
		for (const ext of pathext) {
			for (const dir of dirs) {
				const candidate = join(dir, command + ext);
				if (isExecutable(candidate)) return candidate;
			}
		}
	}
	return null;
}

/** Public export for testing (#582). */
export function _findInPath(command: string): string | null {
	return findInPath(command);
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
		join(home, ".local", "share", "pnpm", "bin", commandName),
		join(home, ".local", "share", "nvim", "mason", "bin", commandName),
		join(home, ".local", "share", "mise", "shims", commandName),
		join(home, ".asdf", "shims", commandName),
		join(home, ".pyenv", "shims", commandName),
		join(home, ".linuxbrew", "bin", commandName),
	];

	// #582: Windows user paths for globally installed tools.
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
		candidates.push(
			// npm global installs
			join(appData, "npm", commandName),
			join(appData, "npm", commandName + ".cmd"),
			// Scoop shims
			join(home, "scoop", "shims", commandName + ".exe"),
			join(home, "scoop", "shims", commandName + ".cmd"),
			// Cargo (Rust) global installs
			join(home, ".cargo", "bin", commandName + ".exe"),
			// Go global installs (gopls, staticcheck via `go install`) -- #606
			join(home, "go", "bin", commandName + ".exe"),
			// Neovim Mason LSP installs
			join(localAppData, "nvim-data", "mason", "bin", commandName + ".cmd"),
			join(localAppData, "nvim-data", "mason", "bin", commandName + ".exe"),
			// VS Code bundled servers (if installed via VS Code extension)
			join(localAppData, "Programs", "Microsoft VS Code", "bin", commandName + ".cmd"),
		);
	}

	// Return all matching executables, not just the first (fixes for-of with immediate return)
	const results: string[] = [];
	for (const candidate of candidates) {
		if (isExecutable(candidate)) {
			results.push(candidate);
		}
	}
	// Version manager bin dirs (nvm, fnm, volta) — dynamic, version-dependent
	for (const dir of _getVersionManagerBinDirs()) {
		const candidate = join(dir, commandName);
		if (isExecutable(candidate)) {
			results.push(candidate);
		}
	}
	return results;
}

/** Public export for testing (#582). */
export function _trustedUserCandidates(commandName: string): string[] {
	return trustedUserCandidates(commandName);
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
	// #641: Track the on-disk mtime (mtimeMs) at didOpen time so a later
	// verify call can detect that a file was edited and send didClose for
	// the stale version before the new content is didOpen'd. Without this
	// the LSP server's per-document AST cache returns diagnostics against
	// the OLD content, producing phantom type errors until the user
	// manually `touch`es the file or restarts the language server.
	private _openedFileMtimes = new Map<string, number>();
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
			this._openedFilePaths.clear();
			this._openedFileMtimes.clear();
			this.log?.(`Project root updated to ${this.projectRoot}`);
		}
	}

	// -- Detection --------------------------------------------------------------

	/**
	 * Auto-detect languages in the project and return what was found.
	 * When filePaths is provided (e.g. from graph.fileSymbols.keys()),
	 * skips the directory walk and derives languages from extensions.
	 */
	detectLanguages(filePaths?: Iterable<string>): string[] {
		return detectProjectLanguages(this.projectRoot, 5000, filePaths);
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
		// #450: Use isPathInRoot instead of startsWith for Windows compatibility
		if (!isPathInRoot(absPath, resolve(this.projectRoot))) {
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

			// C2: Check if shutdown was triggered while we were initializing.
			// If so, close the client immediately instead of leaking the process.
			if (this._shuttingDown) {
				await client.close().catch((err) => this.log(`close on shutdown race for ${language} failed: ${err}`));
				return null;
			}

			this.servers.set(language, info);

			// C3: Double-check after server registration -- shutdown() could have
			// raced between the first _shuttingDown check (C2) and servers.set().
			// If shutdown() ran in that window, it took a snapshot of servers before
			// we added this one, so this server would leak. Clean up immediately.
			if (this._shuttingDown) {
				this.servers.delete(language);
				await client
					.close()
					.catch((err) => this.log(`close on shutdown race (post-set) for ${language} failed: ${err}`));
				return null;
			}

			// Re-open previously opened files after server crash/reconnection
			const prevOpened = this._openedFilePaths.get(language);
			if (prevOpened && prevOpened.size > 0) {
				const rootResolved = resolve(this.projectRoot);
				let realRoot: string;
				try {
					realRoot = realpathSync(rootResolved);
				} catch (err) {
					_logWarn("_initServerForLanguage", "realpathSync project root failed, using unresolved path", err);
					realRoot = rootResolved;
				}
				const entries = [...prevOpened];
				const readResults = await Promise.allSettled(
					entries.map(async (filePath) => {
						const absPath = resolve(detection.workspaceRoot, filePath);
						if (!isPathInRoot(absPath, rootResolved)) {
							_logWarn("_initServerForLanguage", `skipping out-of-root file after restart: ${filePath}`);
							return { filePath, content: null, skipped: true };
						}
						try {
							const realAbs = realpathSync(absPath);
							if (!isPathInRoot(realAbs, realRoot)) {
								_logWarn("_initServerForLanguage", `skipping symlink-escaped file after restart: ${filePath}`);
								return { filePath, content: null, skipped: true };
							}
						} catch (err) {
							_logWarn("_initServerForLanguage", `skipping unreadable file after restart: ${filePath}`, err);
							return { filePath, content: null, skipped: true };
						}
						const content = await readFileAdaptiveAsync(absPath);
						return { filePath, content, skipped: false };
					}),
				);
				await Promise.allSettled(
					readResults.map(async (result) => {
						if (result.status === "fulfilled") {
							if (result.value.skipped || result.value.content === null) {
								prevOpened.delete(result.value.filePath);
								return;
							}
							try {
								await client.didOpen(result.value.filePath, result.value.content);
								// #641: re-open after a server restart re-uses
								// the on-disk content we just read. Record its
								// current mtime so a subsequent verify cycle can
								// detect edits the same way it does for the
								// primary didOpen path in runLspDiagnostics.
								let mtime: number | undefined;
								try {
									mtime = statSync(resolve(detection.workspaceRoot, result.value.filePath)).mtimeMs;
								} catch (_err) {
									mtime = undefined;
								}
								this._openedFileMtimes.set(result.value.filePath, mtime ?? Date.now());
							} catch (err) {
								_logWarn("_initServerForLanguage", `re-open failed for ${result.value.filePath}`, err);
								prevOpened.delete(result.value.filePath);
								this._openedFileMtimes.delete(result.value.filePath);
							}
						} else {
							const filePath = entries[readResults.indexOf(result)]!;
							_logWarn("_initServerForLanguage", `read failed for ${filePath}`, result.reason);
							prevOpened.delete(filePath);
							this._openedFileMtimes.delete(filePath);
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
	 *
	 * When `mtime` is provided, also record the on-disk mtime in the
	 * per-file cache so a later `invalidateIfStale` can detect that the
	 * file was edited between two verify calls (#641). The mtime argument
	 * is optional for backward compatibility: callers that do not have
	 * a fresh mtime (e.g. the closeOpenedFiles re-open path that never
	 * re-reads the file) can omit it.
	 */
	trackOpenedFile(language: string, filePath: string, mtime?: number): void {
		let paths = this._openedFilePaths.get(language);
		if (!paths) {
			paths = new Set();
			this._openedFilePaths.set(language, paths);
		}
		paths.add(filePath);
		if (typeof mtime === "number") {
			this._openedFileMtimes.set(filePath, mtime);
		}
	}

	/**
	 * #641: If the file's on-disk mtime is newer than the one recorded at
	 * didOpen time, send `textDocument/didClose` to the LSP server so it
	 * drops its stale per-document AST, and remove the cached mtime entry
	 * so a subsequent `didOpen` is not short-circuited by the client's
	 * own `_openedFiles` guard.
	 *
	 * Returns `true` when a didClose was sent, `false` when the file is
	 * either not tracked or the mtime is unchanged. Best-effort: a didClose
	 * failure is logged via _logWarn and swallowed so a single bad file
	 * does not block the verify cycle.
	 */
	async invalidateIfStale(filePath: string, currentMtime: number): Promise<boolean> {
		const recorded = this._openedFileMtimes.get(filePath);
		// No record -> never opened through us (or was already closed).
		if (recorded === undefined) return false;
		// mtime unchanged -> cache is fresh.
		if (currentMtime <= recorded) return false;

		// Stale: drop the mtime entry first so a concurrent re-entry does
		// not double-close. Then attempt didClose best-effort.
		this._openedFileMtimes.delete(filePath);
		try {
			// Resolve the language server that owns this file. The file
			// may have moved to a new language if the project language set
			// changed; fall back to scanning all active servers.
			let client: { didClose(filePath: string): Promise<void> } | null = null;
			for (const info of this.servers.values()) {
				if (info.client.isFileOpened(filePath)) {
					client = info.client;
					break;
				}
			}
			if (client) {
				await client.didClose(filePath);
			}
			return true;
		} catch (err) {
			_logWarn("invalidateIfStale", `didClose failed for ${filePath}`, err);
			return true; // we still cleared the local entry, so the next didOpen will succeed
		}
	}

	/**
	 * Send didClose to every file currently tracked in _openedFilePaths and
	 * clear the tracking map. Called by verify after diagnostics collection
	 * completes (#626) so the LSP server releases per-document AST memory
	 * instead of accumulating it across the MCP process lifetime.
	 *
	 * Best-effort: a single didClose failure does not abort the loop. The
	 * local tracking map is cleared regardless of remote success so the
	 * next verify cycle re-opens a clean set.
	 */
	async closeOpenedFiles(): Promise<void> {
		const entries = [...this._openedFilePaths.entries()];
		for (const [language, paths] of entries) {
			const info = this.servers.get(language);
			if (!info) {
				// Server gone — just clear the tracking entries
				paths.clear();
				continue;
			}
			const filePaths = [...paths];
			await Promise.allSettled(
				filePaths.map(async (filePath) => {
					try {
						await info.client.didClose(filePath);
					} catch (err) {
						_logWarn("closeOpenedFiles", `didClose failed for ${filePath}`, err);
					} finally {
						// #641: drop the cached mtime in lockstep with the
						// path tracking entry. A subsequent verify cycle
						// must re-stat the file and treat it as a fresh
						// open, not a stale one.
						this._openedFileMtimes.delete(filePath);
					}
				}),
			);
			paths.clear();
		}
	}

	async shutdown(): Promise<void> {
		this._shuttingDown = true;
		// Snapshot entries before clearing the map to avoid mutation during iteration
		const snapshot = [...this.servers.entries()];
		this.servers.clear();
		this._openedFilePaths.clear();
		this._openedFileMtimes.clear();
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

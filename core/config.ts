/**
 * pi-shazam core/config -- User-facing project config file loader.
 *
 * Reads `.pi-shazam/config.json` from the project root on first access
 * and caches the parsed result for the lifetime of the process. The
 * file is optional: when missing, the loader returns an empty object
 * and the rest of the system falls back to its hard-coded defaults.
 *
 * Schema is intentionally loose (#630). Only the `verify` section is
 * currently consumed; unknown top-level keys are preserved as-is so
 * future migrations can read them without a schema bump. Tools that
 * need a specific value (e.g. `verify.maxFiles`) apply their own
 * validation in the dispatcher.
 *
 * Resolution precedence for option values (highest wins):
 *   1. explicit call argument (e.g. dispatcher `params.maxFiles`)
 *   2. config-file value (`verify.maxFiles`)
 *   3. hard-coded default (e.g. 100)
 *
 * Layer rule: this module lives in `core/`, so it must not import
 * from `tools/`, `hooks/`, or `lsp/`. It is consumed by
 * `tools/_dispatchers.ts` and `tools/verify.ts` only.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getEffectiveRoot } from "./scanner.js";
import { _logWarn } from "./output.js";
import { readFileAdaptive } from "./encoding.js";

/**
 * Per-tool config block. Each tool that opts into config-file-driven
 * settings gets its own sub-interface so the schema stays discoverable.
 */
export interface PiShazamVerifyConfig {
	/**
	 * Maximum number of files passed to the LSP server for diagnostics
	 * in a single `shazam_verify` call. Must be a positive integer.
	 * When omitted, the dispatcher falls back to the hard-coded
	 * default of 100.
	 */
	maxFiles?: number;
}

export interface PiShazamConfig {
	verify?: PiShazamVerifyConfig;
	// Future tools can add their own sections here without a schema
	// bump -- the loose schema preserves unknown top-level keys.
	[key: string]: unknown;
}

// Module-level cache. Cleared by _resetConfigCache in tests only.
let _cached: PiShazamConfig | null = null;

/**
 * Load the project's `.pi-shazam/config.json`. Returns an empty object
 * when the file is missing or malformed; logs a warning via `_logWarn`
 * in the malformed case so the user can see the parse error.
 *
 * The result is cached on first successful read. Use
 * `_resetConfigCache` only in tests.
 */
export function loadConfig(projectRoot?: string): PiShazamConfig {
	if (_cached !== null) return _cached;
	const root = projectRoot ?? getEffectiveRoot();
	const configPath = join(root, ".pi-shazam", "config.json");
	if (!existsSync(configPath)) {
		_cached = {};
		return _cached;
	}
	try {
		const raw = readFileAdaptive(configPath);
		const parsed = JSON.parse(raw) as unknown;
		// Defensive: a JSON literal (null, number, string) parses but is
		// not a valid config object. Treat as missing and warn.
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			_logWarn("loadConfig", `${configPath} is not a JSON object, using defaults`);
			_cached = {};
			return _cached;
		}
		_cached = parsed as PiShazamConfig;
		return _cached;
	} catch (err) {
		_logWarn("loadConfig", `failed to parse ${configPath}, using defaults`, err);
		_cached = {};
		return _cached;
	}
}

/**
 * Reset the module-level config cache. Exported for tests only --
 * production code paths should never call this, since the project
 * config is loaded once at module init and shared across all
 * dispatches in the same process.
 */
export function _resetConfigCache(): void {
	_cached = null;
}

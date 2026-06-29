/**
 * pi-shazam hooks/pre-edit -- Pre-edit impact analysis guard.
 *
 * Intercepts tool_call events for write/edit and detects when:
 *   1. Multiple files are about to be edited in a single turn
 *
 * When triggered, it sends a warning message suggesting the user run
 * shazam_impact first to assess blast radius.
 */

import type { ExtensionAPI, ToolCallEventResult } from "../types/pi-extension.js";
import { resolve } from "node:path";
import { isTrackableEditedPath } from "../core/filter.js";
import { hasPendingImpact } from "./impact-state.js";
import { _logInternal } from "../core/output.js";

/**
 * Filenames that represent project-wide configuration files.
 * Editing any of these can affect the entire project even when only
 * a single file is touched, so they trigger an impact warning regardless
 * of edit count.
 */
const GLOBAL_CONFIG_FILENAMES = new Set([
	"package.json",
	"tsconfig.json",
	"tsconfig.base.json",
	"tsconfig.build.json",
	"jsconfig.json",
	"Cargo.toml",
	"Cargo.lock",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"go.mod",
	"go.sum",
	"Makefile",
	"CMakeLists.txt",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	".env",
	".env.example",
	".env.local",
	"vite.config.ts",
	"vite.config.js",
	"webpack.config.js",
	"rollup.config.js",
	"eslint.config.js",
	"eslint.config.mjs",
	"pnpm-workspace.yaml",
	"lerna.json",
	"nx.json",
	"turbo.json",
	"renovate.json",
	".github/dependabot.yml",
	"ci.yml",
]);

/**
 * Track warned file groups to prevent repeated impact notifications
 * for the same set of files within a session.
 * Map<sorted-key, timestampMs>. TTL auto-evicts after 5 minutes.
 */
const _warnedFileGroups = new Map<string, number>();
const WARN_GROUP_TTL_MS = 5 * 60 * 1000;

function _pruneWarnedGroups(): void {
	const cutoff = Date.now() - WARN_GROUP_TTL_MS;
	for (const [key, ts] of _warnedFileGroups) {
		if (ts < cutoff) _warnedFileGroups.delete(key);
	}
}

function _wasGroupWarned(files: string[]): boolean {
	_pruneWarnedGroups();
	const key = [...files].sort().join(",");
	return _warnedFileGroups.has(key);
}

function _markGroupWarned(files: string[]): void {
	const key = [...files].sort().join(",");
	_warnedFileGroups.set(key, Date.now());
}

/** Maximum number of edited files tracked in the set. */
const MAX_EDITED_FILES = 100;

/**
 * Track files edited in the current session for multi-edit detection.
 * Key: normalized file path, Value: insertion order timestamp.
 */
const _editedFiles = new Map<string, number>();
let _editCounter = 0;

/**
 * Track tentative file additions from tool_call for removal on failed tool_result.
 */
const _tentativeFiles = new Map<string, Set<string>>();

/**
 * Track setTimeout handles for TTL-based eviction, keyed by toolCallId.
 * Handles are unref()'d so they don't keep the process alive.
 */
const _timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Normalize a file path to prevent duplicate tracking of the same file
 * under different path representations (e.g. "./src/foo.ts" vs "src/foo.ts").
 */
export function normalizeEditedPath(filePath: string, cwd: string): string {
	return resolve(cwd, filePath);
}

/**
 * Get the list of files that have been edited so far in this session.
 */
export function getEditedFiles(): string[] {
	return [..._editedFiles.keys()];
}

/**
 * Add a file to the edited files tracker with eviction of oldest entries.
 */
function addEditedFile(file: string): void {
	// Evict oldest entry if at capacity
	if (_editedFiles.size >= MAX_EDITED_FILES && !_editedFiles.has(file)) {
		let oldestFile: string | null = null;
		let oldestTime = Infinity;
		for (const [f, t] of _editedFiles) {
			if (t < oldestTime) {
				oldestTime = t;
				oldestFile = f;
			}
		}
		if (oldestFile) _editedFiles.delete(oldestFile);
	}
	_editedFiles.set(file, ++_editCounter);
}

/**
 * Clear the edited files tracker.
 */
export function clearEditedFiles(): void {
	for (const handle of _timeoutHandles.values()) {
		clearTimeout(handle);
	}
	_timeoutHandles.clear();
	_editedFiles.clear();
	_editCounter = 0;
	_tentativeFiles.clear();
	_warnedFileGroups.clear();
}

/**
 * Extract file paths from a tool call's input parameters.
 */
function extractFilesFromInput(input: unknown): string[] {
	const files: string[] = [];
	if (input && typeof input === "object") {
		const obj = input as Record<string, unknown>;

		// Tool calls may have `path` (write), `file` (edit), or `files` (impact)
		if (typeof obj.path === "string") files.push(obj.path);
		if (typeof obj.file === "string") files.push(obj.file);
		if (Array.isArray(obj.files)) {
			for (const f of obj.files) {
				if (typeof f === "string") files.push(f);
			}
		}

		// For edit tool, the edits array may contain file paths
		if (Array.isArray(obj.edits)) {
			for (const edit of obj.edits) {
				if (edit && typeof edit === "object" && typeof (edit as Record<string, unknown>).path === "string") {
					files.push((edit as Record<string, unknown>).path as string);
				}
			}
		}
	}
	return [...new Set(files)];
}

/**
 * Register the pre-edit guard hook.
 *
 * On tool_call for write/edit, checks if the edit affects multiple files
 * or modifies a shared module and sends a warning message.
 *
 * On tool_result for failed writes, removes tentatively tracked files.
 */
export function registerPreEditGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx): ToolCallEventResult | void => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		// Block edits when a GitHub issue was created but impact analysis
		// has not been run yet (set by hooks/issue-guard.ts)
		if (hasPendingImpact()) {
			return {
				block: true,
				reason:
					"GitHub issue created but shazam_impact not run yet. Run shazam_impact first to assess blast radius, then retry editing.",
			};
		}

		const input = event.input;

		const rawFiles = extractFilesFromInput(input);
		if (rawFiles.length === 0) return;

		// Normalize paths to avoid duplicate tracking, then drop paths that
		// point outside the project tree (tmp, dot-dirs, node_modules, dist,
		// json files). Tracking those would trigger spurious verify reminders.
		const files = rawFiles.map((f) => normalizeEditedPath(f, ctx.cwd)).filter(isTrackableEditedPath);
		if (files.length === 0) return;

		// Track tentatively for this tool call (for removal on failure).
		// Also schedule TTL-based eviction in case tool_result never arrives.
		const toolId = event.toolCallId;
		if (toolId) {
			if (!_tentativeFiles.has(toolId)) _tentativeFiles.set(toolId, new Set());
			for (const f of files) {
				_tentativeFiles.get(toolId)!.add(f);
			}
			// Clean up orphaned entries after 5 minutes if tool_result never arrives
			const handle = setTimeout(
				() => {
					if (_tentativeFiles.has(toolId)) {
						for (const f of _tentativeFiles.get(toolId)!) {
							_editedFiles.delete(f);
						}
						_tentativeFiles.delete(toolId);
					}
					_timeoutHandles.delete(toolId);
				},
				5 * 60 * 1000,
			);
			handle.unref();
			_timeoutHandles.set(toolId, handle);
		}

		// Track files for multi-edit detection (with eviction)
		if (toolId) {
			for (const f of files) {
				addEditedFile(f);
			}
		}

		// Combine current files with previously edited files
		const allFiles = getEditedFiles();

		// Check conditions for suggesting impact analysis
		const reasons: string[] = [];
		let hasGlobalConfig = false;

		// Condition 1: Multiple files edited in this session
		if (allFiles.length >= 2) {
			reasons.push(`This session has touched ${allFiles.length} files`);
		}

		// Condition 2: At least one file is a global configuration file.
		// Global configs affect the entire project and warrant an impact
		// analysis even when only a single file is being edited.
		for (const f of allFiles) {
			const basename = f.split("/").pop() ?? "";
			if (GLOBAL_CONFIG_FILENAMES.has(basename)) {
				hasGlobalConfig = true;
				reasons.push(`editing global config \`${basename}\``);
				break;
			}
			// Also match well-known config sub-paths like ".github/workflows/ci.yml"
			if (f.includes("/.github/") || f.includes("/.config/")) {
				const relName = f.split("/").slice(-2).join("/");
				if (GLOBAL_CONFIG_FILENAMES.has(relName)) {
					hasGlobalConfig = true;
					reasons.push(`editing global config \`${relName}\``);
					break;
				}
			}
		}

		// Condition 3: Current files include a global config (single-file warning)
		if (!hasGlobalConfig) {
			for (const f of files) {
				const basename = f.split("/").pop() ?? "";
				if (GLOBAL_CONFIG_FILENAMES.has(basename)) {
					hasGlobalConfig = true;
					reasons.push(`editing global config \`${basename}\``);
					break;
				}
			}
		}

		if (reasons.length > 0 && !_wasGroupWarned(allFiles)) {
			_markGroupWarned(allFiles);
			ctx.ui.notify(
				`[shazam] Caution: ${reasons.join("; ")}. Run \`shazam_impact --files ${allFiles.join(" ")}\` to assess blast radius before editing.`,
				"warning",
			);
			_logInternal("pre-edit", "multi-file edit warning", { fileCount: allFiles.length, files: allFiles });
		}
	});

	// On tool_result: remove tentatively tracked files if the tool call failed
	pi.on("tool_result", (event) => {
		const toolId = event.toolCallId;

		// Clear any TTL timeout for this tool call
		if (toolId && _timeoutHandles.has(toolId)) {
			clearTimeout(_timeoutHandles.get(toolId)!);
			_timeoutHandles.delete(toolId);
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (!event.isError) {
			if (toolId) _tentativeFiles.delete(toolId);
			return;
		}

		if (toolId && _tentativeFiles.has(toolId)) {
			for (const f of _tentativeFiles.get(toolId)!) {
				_editedFiles.delete(f);
			}
			_tentativeFiles.delete(toolId);
		}
	});

	// Clear edited files on session start and shutdown
	pi.on("session_start", () => {
		clearEditedFiles();
	});

	pi.on("session_shutdown", () => {
		clearEditedFiles();
	});
}

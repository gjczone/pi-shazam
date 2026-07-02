/**
 * pi-shazam core/cache -- Graph baseline save/diff for incremental analysis.
 *
 * Provides persistent graph caching with mtime-based invalidation.
 * Stores cache under ~/.cache/repomap/<project-slug> for process-isolated
 * cache directories. Supports V2 serialization with file-level data.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { serializeGraphV2, deserializeGraphV2 } from "./graph.js";
import type { RepoGraph, GraphCacheData as GraphCacheDataExport } from "./graph.js";
import { _logWarn } from "./output.js";

// -- Cache directory management -----------------------------------------------

/**
 * Get the platform-appropriate cache root directory.
 *
 * - Windows: %LOCALAPPDATA%\pi-shazam\cache (or %USERPROFILE%\AppData\Local fallback)
 * - macOS: ~/Library/Caches/pi-shazam
 * - Linux: $XDG_CACHE_HOME/pi-shazam (or ~/.cache/pi-shazam fallback)
 */
function getCacheRoot(): string {
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
		return join(localAppData, "pi-shazam", "cache");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Caches", "pi-shazam");
	}
	const xdgCache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(xdgCache, "pi-shazam");
}

export const CACHE_ROOT = getCacheRoot();
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day - prevents stale cache in active projects (fixes #100)
// M2: Shared size limit for cache files - both load and save respect this (prevents OOM on huge projects)
const MAX_CACHE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Get the cache directory for a specific project.
 * Uses SHA-256 hash of canonical path for isolation.
 */
export function getProjectCacheDir(projectPath: string): string {
	// #584: Strip both Unix (/) and Windows (\) trailing separators
	const canonical = projectPath.replace(/[\\/]$/, "");
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
	const projectName = canonical.split("/").pop() || "unknown";
	const cacheDir = join(CACHE_ROOT, `${projectName}_${hash}`);
	try {
		mkdirSync(cacheDir, { recursive: true });
	} catch (err) {
		// Cache directory is a best-effort optimization. If we cannot create it
		// (EACCES, EROFS, ENOSPC, ENAMETOOLONG), degrade gracefully: log a
		// warning and continue without caching. The scan itself still works.
		_logWarn("getProjectCacheDir", `cannot create cache directory ${cacheDir}`, err);
	}
	return cacheDir;
}

// -- Persistent graph cache (V2) ----------------------------------------------

/**
 * Atomically rename a temp file to a target path, handling Windows EPERM/EBUSY
 * by unlinking the target first and retrying.
 */
function atomicRename(tmpPath: string, targetPath: string): void {
	try {
		renameSync(tmpPath, targetPath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EBUSY") {
			try {
				unlinkSync(targetPath);
			} catch (unlinkErr) {
				// ENOENT here is genuinely expected -- the target does not exist
				// yet on the first rename. Only log non-ENOENT failures (#551:
				// blanket global suppression in _logWarn was removed; guard locally).
				if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
					_logWarn("atomicRename", "unlinkSync target failed", unlinkErr);
				}
			}
			renameSync(tmpPath, targetPath);
		} else {
			throw err;
		}
	}
}

/**
 * Save the full graph + file mtimes to a persistent cache file.
 * Uses atomic write (tmp file + rename) to prevent corruption on crash.
 */
export function saveGraphCache(graph: RepoGraph, fileMtimes: Map<string, number>, cachePath: string): void {
	const serialized = serializeGraphV2(graph, fileMtimes);
	mkdirSync(dirname(cachePath), { recursive: true });
	const tmpPath = cachePath + ".tmp";
	try {
		const json = JSON.stringify(serialized);
		// M2: Enforce size limit on save too, not just load — prevents OOM on huge projects.
		// Use Buffer.byteLength to match the byte-count gate at load time (stat.size is in bytes).
		if (Buffer.byteLength(json, "utf-8") > MAX_CACHE_SIZE) {
			_logWarn(
				"saveGraphCache",
				`serialized graph too large (${Buffer.byteLength(json, "utf-8")} bytes), skipping cache`,
			);
			return;
		}
		writeFileSync(tmpPath, json, "utf-8");
		atomicRename(tmpPath, cachePath);
	} catch (err) {
		// Clean up tmp file on failure
		try {
			unlinkSync(tmpPath);
		} catch (cleanupErr) {
			_logWarn("saveGraphCache", "failed to clean up tmp file", cleanupErr);
		}
		throw err;
	}
}

export type GraphCacheData = GraphCacheDataExport;

/**
 * Load a persistent graph cache. Returns null if missing, corrupt, wrong
 * version, or older than 1 day.
 */
export function loadGraphCache(cachePath: string): GraphCacheData | null {
	if (!existsSync(cachePath)) return null;
	try {
		const cacheStat = statSync(cachePath);
		if (cacheStat.size > MAX_CACHE_SIZE) {
			_logWarn("loadGraphCache", `cache file too large (${cacheStat.size} bytes), skipping`);
			return null;
		}
		const raw = readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw);
		if (!data || data.version !== 3 || !Array.isArray(data.symbols) || !Array.isArray(data.edges)) return null;
		if (Date.now() - data.timestamp > CACHE_MAX_AGE_MS) return null;

		const graph = deserializeGraphV2(data);
		const fileMtimes = new Map<string, number>();
		for (const [k, v] of Object.entries(data.fileMtimes)) {
			fileMtimes.set(k, v as number);
		}

		return { graph, fileMtimes, timestamp: data.timestamp };
	} catch (err) {
		_logWarn("loadGraphCache", "failed to parse graph cache", err);
		return null;
	}
}

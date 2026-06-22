/**
 * pi-shazam core/cache — Graph baseline save/diff for incremental analysis.
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

// ── Cache directory management ───────────────────────────────────────────────

const CACHE_ROOT = join(homedir(), ".cache", "repomap");

/**
 * Get the cache directory for a specific project.
 * Uses SHA-256 hash of canonical path for isolation.
 */
export function getProjectCacheDir(projectPath: string): string {
	const canonical = projectPath.replace(/\/$/, "");
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
	const projectName = canonical.split("/").pop() || "unknown";
	const cacheDir = join(CACHE_ROOT, `${projectName}_${hash}`);
	mkdirSync(cacheDir, { recursive: true });
	return cacheDir;
}

// ── Persistent graph cache (V2) ──────────────────────────────────────────────

/** Max age for a cached graph file before it is considered stale. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day — prevents stale cache in active projects (fixes #100)

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
			} catch {
				/* target may not exist */
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
		writeFileSync(tmpPath, JSON.stringify(serialized), "utf-8");
		atomicRename(tmpPath, cachePath);
	} catch (err) {
		// Clean up tmp file on failure
		try {
			unlinkSync(tmpPath);
		} catch {
			/* ignore cleanup error */
		}
		throw err;
	}
}

export type GraphCacheData = GraphCacheDataExport;

/**
 * Load a persistent graph cache. Returns null if missing, corrupt, wrong
 * version, or older than 7 days.
 */
export function loadGraphCache(cachePath: string): GraphCacheData | null {
	if (!existsSync(cachePath)) return null;
	try {
		const MAX_CACHE_SIZE = 20 * 1024 * 1024; // 20MB
		const cacheStat = statSync(cachePath);
		if (cacheStat.size > MAX_CACHE_SIZE) {
			console.warn(`[pi-shazam] Cache file too large (${cacheStat.size} bytes), skipping`);
			return null;
		}
		const raw = readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw);
		if (!data || data.version !== 2 || !Array.isArray(data.symbols) || !Array.isArray(data.edges)) return null;
		if (Date.now() - data.timestamp > CACHE_MAX_AGE_MS) return null;

		const graph = deserializeGraphV2(data);
		const fileMtimes = new Map<string, number>();
		for (const [k, v] of Object.entries(data.fileMtimes)) {
			fileMtimes.set(k, v as number);
		}

		return { graph, fileMtimes, timestamp: data.timestamp };
	} catch (err) {
		console.warn(`[pi-shazam] loadGraphCache: failed to parse graph cache: ${err}`);
		return null;
	}
}

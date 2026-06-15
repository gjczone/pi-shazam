/**
 * pi-shazam core/cache — Graph baseline save/diff for incremental analysis.
 *
 * Provides persistent graph caching with mtime-based invalidation.
 * Stores cache under ~/.cache/repomap/<project-slug> for process-isolated
 * cache directories. Supports V2 serialization with file-level data.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { serializeGraphV2, deserializeGraphV2, compareGraphSnapshots } from "./graph.js";
import type { RepoGraph, GraphDiff, Symbol, Edge, SerializedSymbol, SerializedEdge } from "./graph.js";

// ── Cache directory management ───────────────────────────────────────────────

const CACHE_ROOT = join(homedir(), ".cache", "repomap");

/**
 * Get the cache directory for a specific project.
 * Uses MD5 hash of canonical path for isolation.
 */
export function getProjectCacheDir(projectPath: string): string {
	const canonical = projectPath.replace(/\/$/, "");
	const hash = createHash("md5").update(canonical).digest("hex").slice(0, 8);
	const projectName = canonical.split("/").pop() || "unknown";
	const cacheDir = join(CACHE_ROOT, `${projectName}_${hash}`);
	mkdirSync(cacheDir, { recursive: true });
	return cacheDir;
}

/**
 * Get the standard cache file paths for a project.
 */
export function getCachePaths(projectPath: string): {
	symbols: string;
	git: string;
	lastSnapshot: string;
} {
	const dir = getProjectCacheDir(projectPath);
	return {
		symbols: join(dir, "symbols.json"),
		git: join(dir, "git.json"),
		lastSnapshot: join(dir, "last_snapshot.json"),
	};
}

// ── Baseline load (V1 format, for backward compatibility) ────────────────────

/**
 * V1 baseline data format (kept for reading legacy baseline files).
 */
interface BaselineData {
	symbols: SerializedSymbol[];
	edges: SerializedEdge[];
	version: number;
	timestamp: number;
}

/**
 * Load a previously saved baseline snapshot (V1 format).
 */
export function loadBaseline(projectPath: string): BaselineData | null {
	const { symbols } = getCachePaths(projectPath);
	if (!existsSync(symbols)) return null;
	try {
		const raw = readFileSync(symbols, "utf-8");
		const data = JSON.parse(raw);
		if (!data || !Array.isArray(data.symbols) || !Array.isArray(data.edges)) {
			return null;
		}
		return data as BaselineData;
	} catch (err) {
		console.warn(`[pi-shazam] loadBaseline: failed to parse baseline cache: ${err}`);
		return null;
	}
}

// ── Graph diff (current vs baseline) ─────────────────────────────────────────

/**
 * Compute the difference between the current graph and a saved baseline.
 * Returns a structured diff with added/removed/modified symbols and edges.
 */
export function diffBaseline(graph: RepoGraph, projectPath: string): GraphDiff | null {
	const baseline = loadBaseline(projectPath);
	if (!baseline) return null;

	const currentSymbols: Symbol[] = [...graph.symbols.values()];
	const currentEdges: Edge[] = [];
	for (const [, edges] of graph.outgoing) {
		for (const e of edges) {
			currentEdges.push(e);
		}
	}

	return compareGraphSnapshots(currentSymbols, currentEdges, baseline.symbols, baseline.edges);
}

// ── Persistent graph cache (V2) ──────────────────────────────────────────────

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day — prevents stale cache in active projects (fixes #100)

/**
 * Save the full graph + file mtimes to a persistent cache file.
 */
export function saveGraphCache(graph: RepoGraph, fileMtimes: Map<string, number>, cachePath: string): void {
	const serialized = serializeGraphV2(graph, fileMtimes);
	mkdirSync(dirname(cachePath), { recursive: true });
	writeFileSync(cachePath, JSON.stringify(serialized), "utf-8");
}

export interface GraphCacheData {
	graph: RepoGraph;
	fileMtimes: Map<string, number>;
	timestamp: number;
}

/**
 * Load a persistent graph cache. Returns null if missing, corrupt, wrong
 * version, or older than 7 days.
 */
export function loadGraphCache(cachePath: string): GraphCacheData | null {
	if (!existsSync(cachePath)) return null;
	try {
		const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
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

/**
 * Re-export serialization helpers for convenience.
 */
export { compareGraphSnapshots };

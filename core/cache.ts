/**
 * pi-shazam core/cache — Graph baseline save/diff for incremental analysis.
 *
 * Ported from repomap/src/__init__.py (get_project_cache_dir, compare_graph_snapshots,
 * IncrementalCache).
 *
 * Uses Node.js fs + path for file I/O, matching repomap's convention of
 * storing cache under ~/.cache/repomap/<project-slug>.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
	serializeGraph,
	serializeSymbol,
	serializeEdge,
	serializeGraphV2,
	deserializeGraphV2,
	compareGraphSnapshots,
} from "./graph.js";
import type { RepoGraph, SerializedGraph, GraphDiff, Symbol, Edge } from "./graph.js";

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

// ── Baseline save/load ───────────────────────────────────────────────────────

/**
 * Save the current graph as a baseline snapshot.
 */
export function saveBaseline(graph: RepoGraph, projectPath: string): string {
	const { symbols } = getCachePaths(projectPath);
	const serialized = serializeGraph(graph);
	mkdirSync(dirname(symbols), { recursive: true });
	writeFileSync(symbols, JSON.stringify(serialized, null, 2), "utf-8");
	return symbols;
}

/**
 * Load a previously saved baseline snapshot.
 */
export function loadBaseline(projectPath: string): SerializedGraph | null {
	const { symbols } = getCachePaths(projectPath);
	if (!existsSync(symbols)) return null;
	try {
		const raw = readFileSync(symbols, "utf-8");
		const data = JSON.parse(raw);
		if (!data || !Array.isArray(data.symbols) || !Array.isArray(data.edges)) {
			return null;
		}
		return data as SerializedGraph;
	} catch {
		return null;
	}
}

/**
 * Save the last snapshot (timestamp + metadata only, not full graph).
 */
export function saveLastSnapshot(projectPath: string, metadata: Record<string, unknown>): string {
	const { lastSnapshot } = getCachePaths(projectPath);
	const data = {
		timestamp: Date.now(),
		...metadata,
	};
	mkdirSync(dirname(lastSnapshot), { recursive: true });
	writeFileSync(lastSnapshot, JSON.stringify(data, null, 2), "utf-8");
	return lastSnapshot;
}

/**
 * Load the last snapshot metadata.
 */
export function loadLastSnapshot(projectPath: string): Record<string, unknown> | null {
	const { lastSnapshot } = getCachePaths(projectPath);
	if (!existsSync(lastSnapshot)) return null;
	try {
		const raw = readFileSync(lastSnapshot, "utf-8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
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

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
	} catch {
		return null;
	}
}

/**
 * Re-export serialization helpers for convenience.
 */
export { serializeGraph, serializeSymbol, serializeEdge, compareGraphSnapshots };

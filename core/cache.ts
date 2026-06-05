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
	compareGraphSnapshots,
} from "./graph.js";
import type {
	RepoGraph,
	SerializedGraph,
	GraphDiff,
	Symbol,
	Edge,
} from "./graph.js";

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
		return JSON.parse(raw) as SerializedGraph;
	} catch {
		return null;
	}
}

/**
 * Save the last snapshot (timestamp + metadata only, not full graph).
 */
export function saveLastSnapshot(
	projectPath: string,
	metadata: Record<string, unknown>,
): string {
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
export function loadLastSnapshot(
	projectPath: string,
): Record<string, unknown> | null {
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
export function diffBaseline(
	graph: RepoGraph,
	projectPath: string,
): GraphDiff | null {
	const baseline = loadBaseline(projectPath);
	if (!baseline) return null;

	const currentSymbols: Symbol[] = [...graph.symbols.values()];
	const currentEdges: Edge[] = [];
	for (const [, edges] of graph.outgoing) {
		for (const e of edges) {
			currentEdges.push(e);
		}
	}

	return compareGraphSnapshots(
		currentSymbols,
		currentEdges,
		baseline.symbols,
		baseline.edges,
	);
}

/**
 * Re-export serialization helpers for convenience.
 */
export {
	serializeGraph,
	serializeSymbol,
	serializeEdge,
	compareGraphSnapshots,
};

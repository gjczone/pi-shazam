/**
 * run-verify.mjs — Run shazam_verify + compute critical paths → result JSON
 *
 * #638: GitHub Action wrapper for shazam_verify
 *
 * Usage: node run-verify.mjs <dist-dir> <project-root> <max-files>
 *
 * This script:
 * 1. Dynamic-imports `executeVerifyJsonAsync` from the resolved dist
 * 2. Runs verify with the given project root and maxFiles
 * 3. Computes top-5 critical paths by incoming caller count (PageRank proxy)
 * 4. Writes the enriched result JSON to stdout
 */
import { writeFileSync } from "node:fs";

const [distDir, projectRoot, maxFilesStr] = process.argv.slice(2);
const maxFiles = parseInt(maxFilesStr, 10) || 100;

async function main() {
	// Dynamic import from the resolved dist directory
	const verifyModule = await import(`${distDir}/tools/verify.js`);
	const { executeVerifyJsonAsync } = verifyModule;

	// Also import graph utilities for critical paths
	const graphModule = await import(`${distDir}/core/graph.js`);
	const { getGraphEdgeCount } = graphModule;

	const scannerModule = await import(`${distDir}/core/scanner.js`);
	const { scanProject } = scannerModule;

	// Run verify with json=true (no LSP manager set → tsc subprocess fallback)
	const result = await executeVerifyJsonAsync(projectRoot, { maxFiles });

	// Compute critical paths: scan the graph for symbols with most incoming callers
	let criticalPaths = [];
	try {
		const graph = scanProject(projectRoot);
		// Collect incoming caller counts for all symbols
		const incomingCounts = new Map();
		for (const [, edges] of graph.incoming) {
			// Each entry in incoming is: target symbol → array of source symbols
			// We need to count how many callers each symbol has
		}

		// graph.incoming: Map<target, source[]> — each target has N callers
		for (const [target, sources] of graph.incoming) {
			incomingCounts.set(target, sources.length);
		}

		// Sort by incoming callers descending, take top 5
		const sorted = [...incomingCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

		criticalPaths = sorted.map(([symbol, count]) => ({
			symbol,
			incomingCallers: count,
		}));
	} catch (err) {
		// Critical paths are optional — don't fail the action if graph scan fails
		console.error("Warning: could not compute critical paths:", err.message);
	}

	const envelope = {
		schema_version: "1.0",
		command: "verify",
		project: projectRoot,
		status: "ok",
		result,
		criticalPaths,
	};

	// Write to stdout (entrypoint.sh redirects to file)
	process.stdout.write(JSON.stringify(envelope, null, 2));
}

main().catch((err) => {
	console.error("run-verify failed:", err);
	process.exit(1);
});

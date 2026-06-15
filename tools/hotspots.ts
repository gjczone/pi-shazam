/**
 * pi-shazam tools/hotspots — Complexity hotspot ranking.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { createTool } from "./_factory.js";
import { isNonSourceFile } from "../core/filter.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function registerHotspots(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_hotspots",
		label: "Complexity Hotspots",
		description: `\
		Without this, you optimize the wrong files. Returns files ranked by
		(symbol density x PageRank) — these are the files where bugs have the
		highest blast radius. Use to prioritize code review, decide where to
		write tests first, and understand which files form the project's
		core.`,
		params: Type.Object({ topN: Type.Optional(Type.Number()) }),
		execute(graph, params) {
			const json = params.json ?? false;
			const topN = (params.topN as number) ?? 10;
			return json ? executeHotspotsJson(graph, topN) : executeHotspots(graph, topN);
		},
	});
}

interface FileHotspot {
	file: string;
	symbolCount: number;
	totalPagerank: number;
	incomingRefs: number;
	outgoingRefs: number;
	hotspotScore: number;
}

function getExcludeMessage(): string {
	const projectRoot = process.cwd();
	const exclusions: string[] = [];

	// JS/TS
	if (existsSync(join(projectRoot, "package.json"))) {
		exclusions.push("package-lock.json", "package.json", "tsconfig.json", "node_modules/");
	}
	// Python
	if (existsSync(join(projectRoot, "pyproject.toml")) || existsSync(join(projectRoot, "setup.py"))) {
		exclusions.push("pyproject.toml", "__pycache__/", ".ruff_cache/", ".pytest_cache/");
	}
	// Rust
	if (existsSync(join(projectRoot, "Cargo.toml"))) {
		exclusions.push("Cargo.lock", "target/");
	}
	// Go
	if (existsSync(join(projectRoot, "go.mod"))) {
		exclusions.push("go.sum", "vendor/");
	}
	// Universal
	exclusions.push("dist/");

	return `Config and generated files (${exclusions.join(", ")}) are excluded.`;
}

export function executeHotspots(graph: RepoGraph, topN: number = 10): string {
	const hotspots = computeHotspots(graph, topN);

	const lines: string[] = [];
	lines.push(`## Complexity Hotspots (Top ${topN})`);
	lines.push("");
	lines.push("Ranked by symbol density × PageRank score.");
	lines.push("");
	lines.push(getExcludeMessage());
	lines.push("");

	for (let i = 0; i < hotspots.length; i++) {
		const h = hotspots[i]!;
		lines.push(`${i + 1}. \`${h.file}\` — score: ${h.hotspotScore.toFixed(2)}`);
		lines.push(
			`   ${h.symbolCount} symbols | PageRank: ${h.totalPagerank.toFixed(2)} | in:${h.incomingRefs} out:${h.outgoingRefs}`,
		);
		lines.push("");
	}

	// Add Next recommendations
	const nextItems = getNextForTool("hotspots", { topFile: hotspots[0]?.file });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

export function executeHotspotsJson(graph: RepoGraph, topN: number): string {
	const hotspots = computeHotspots(graph, topN);
	return JSON.stringify({
		schema_version: "1.0",
		command: "hotspots",
		status: "ok",
		result: {
			hotspots: hotspots.map((h) => ({
				file: h.file,
				symbolCount: h.symbolCount,
				totalPagerank: Number(h.totalPagerank.toFixed(4)),
				incomingRefs: h.incomingRefs,
				outgoingRefs: h.outgoingRefs,
				hotspotScore: Number(h.hotspotScore.toFixed(2)),
			})),
		},
	});
}

// ── Note: `isNonSourceFile` is defined in core/filter.ts — imported above

// ── Core compute ────────────────────────────────────────────────────────────────

function computeHotspots(graph: RepoGraph, topN: number): FileHotspot[] {
	const fileStats = new Map<string, FileHotspot>();

	for (const [file, symIds] of graph.fileSymbols) {
		if (isNonSourceFile(file)) continue;

		let totalPR = 0;
		let incoming = 0;
		let outgoing = 0;

		for (const id of symIds) {
			const sym = graph.symbols.get(id);
			if (sym) {
				totalPR += sym.pagerank;
			}
			const inc = graph.incoming.get(id);
			if (inc) incoming += inc.length;
			const out = graph.outgoing.get(id);
			if (out) outgoing += out.length;
		}

		// Hotspot score = symbolCount * totalPagerank (normalized)
		const hotspotScore = symIds.length * totalPR;

		fileStats.set(file, {
			file,
			symbolCount: symIds.length,
			totalPagerank: totalPR,
			incomingRefs: incoming,
			outgoingRefs: outgoing,
			hotspotScore,
		});
	}

	return [...fileStats.values()].sort((a, b) => b.hotspotScore - a.hotspotScore).slice(0, topN);
}

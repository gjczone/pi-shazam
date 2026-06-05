/**
 * pi-shazam tools/hotspots — Complexity hotspot ranking.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { isNonSourceFile } from "../core/filter.js";

export function registerHotspots(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_hotspots",
		label: "Complexity Hotspots",
		description: `\
Call to find complexity hotspots: files ranked by (symbol density ×
PageRank score). The top 5 results are the files where bugs are most
expensive — these files have the highest incoming dependency weight,
meaning changes here cascade into the largest blast radius.

Use this to decide where to focus code review, where to write tests
first, and which files a new developer should read to understand the
project's core.

Scenario: code review prioritization. Deciding which tests to write
next. Understanding where a new team member should start reading.
Triaging bug reports (is the affected file a hotspot?).`,
		parameters: Type.Object({
			topN: Type.Optional(Type.Number()),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const topN = params.topN ?? 10;
			const result = executeHotspots(graph, topN);
			return {
				content: [
					{
						type: "text",
						text: json
							? executeHotspotsJson(graph, topN)
							: result,
					},
				],
			};
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

export function executeHotspots(
	graph: RepoGraph,
	topN: number = 10,
): string {
	const hotspots = computeHotspots(graph, topN);

	const lines: string[] = [];
	lines.push(`## Complexity Hotspots (Top ${topN})`);
	lines.push("");
	lines.push("Ranked by symbol density × PageRank score.");
	lines.push("");
	lines.push("Config and generated files (package-lock.json, package.json, tsconfig.json, dist/, node_modules/) are excluded.");
	lines.push("");

	for (let i = 0; i < hotspots.length; i++) {
		const h = hotspots[i]!;
		lines.push(
			`${i + 1}. \`${h.file}\` — score: ${h.hotspotScore.toFixed(2)}`,
		);
		lines.push(
			`   ${h.symbolCount} symbols | PageRank: ${h.totalPagerank.toFixed(2)} | in:${h.incomingRefs} out:${h.outgoingRefs}`,
		);
		lines.push("");
	}

	return lines.join("\n");
}

export function executeHotspotsJson(
	graph: RepoGraph,
	topN: number,
): string {
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

	return [...fileStats.values()]
		.sort((a, b) => b.hotspotScore - a.hotspotScore)
		.slice(0, topN);
}

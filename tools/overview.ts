/**
 * pi-shazam tools/overview — Project structure summary.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { isNonSourceFile } from "../core/filter.js";
import { getNextForTool, formatNextSection } from "../core/output.js";

export function registerOverview(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_overview",
		label: "Project Overview",
		description: `\
MUST call before touching ANY code in an unfamiliar project or repo.
Returns: module dependency map, top-10 highest-PageRank files (the
"spine" of the codebase), entry points, and suggested reading order.
Supports --filter to search/find files by keyword within the project.
Skipping this = navigating blind — you WILL miss cross-module ripple
effects and waste turns on dead-end reads.

Scenario: first turn in a new repo. After git clone. After switching
to an unfamiliar project directory. Use --filter <keyword> to locate
specific files (replaces separate find_file tool).

Output: plain text summary by default. Pass { json: true } for
structured output with file lists and PageRank scores.`,
		parameters: Type.Object({
			json: Type.Optional(Type.Boolean()),
			filter: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const filter = params.filter ?? "";
			const graph = scanProject(".");
			return {
				content: [
					{
						type: "text",
						text: json
							? executeOverviewJson(graph, ".", filter)
							: executeOverview(graph, ".", filter),
					},
				],
			};
		},
	});
}

export function executeOverview(graph: RepoGraph, _projectRoot: string, filter?: string): string {
	const lines: string[] = [];

	// ── Apply file filtering ───────────────────────────────────────
	const files = filter
		? [...graph.fileSymbols.keys()].filter(
				(f) => !isNonSourceFile(f) && f.includes(filter),
			)
		: [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));

	if (files.length === 0) {
		lines.push("## Project Overview");
		lines.push("");
		lines.push("No matching source files found.");
		return lines.join("\n");
	}

	// Summary stats
	lines.push("## Project Overview");
	lines.push("");
	lines.push(
		`${graph.symbols.size} symbols across ${files.length} source files`,
	);

	// Calculate per-file symbol counts and aggregate PageRank
	const fileStats = new Map<
		string,
		{ count: number; pagerank: number; topSym: string }
	>();
	for (const file of files) {
		const symIds = graph.fileSymbols.get(file);
		if (!symIds) continue;
		let totalPR = 0;
		let topPR = 0;
		let topName = "";
		for (const id of symIds) {
			const sym = graph.symbols.get(id);
			if (sym) {
				totalPR += sym.pagerank;
				if (sym.pagerank > topPR) {
					topPR = sym.pagerank;
					topName = sym.name;
				}
			}
		}
		fileStats.set(file, { count: symIds.length, pagerank: totalPR, topSym: topName });
	}

	// Top files by PageRank
	const topFiles = [...fileStats.entries()]
		.sort((a, b) => b[1].pagerank - a[1].pagerank)
		.slice(0, 10);

	lines.push("");
	lines.push("### Top 10 Files by PageRank");
	lines.push("");
	for (let i = 0; i < topFiles.length; i++) {
		const [file, stats] = topFiles[i]!;
		lines.push(
			`${i + 1}. \`${file}\` — ${stats.count} symbols, PageRank ${stats.pagerank.toFixed(2)}, top symbol: ${stats.topSym}`,
		);
	}

	// Entry points (files with high PageRank and export visibility)
	const entryPoints = [...graph.symbols.values()]
		.filter((s) => s.visibility === "exported" && s.pagerank > 0.01)
		.sort((a, b) => b.pagerank - a.pagerank)
		.slice(0, 10);

	if (entryPoints.length > 0) {
		lines.push("");
		lines.push("### Entry Points");
		lines.push("");
		for (const sym of entryPoints) {
			lines.push(
				`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (PR ${sym.pagerank.toFixed(3)})`,
			);
		}
	}

	// Module dependency summary
	lines.push("");
	lines.push("### Module Structure");
	lines.push("");
	const dirs = new Set<string>();
	for (const file of files) {
		const dir = file.includes("/") ? file.split("/")[0]! : "(root)";
		dirs.add(dir);
	}
	const sortedDirs = [...dirs].sort();
	for (const dir of sortedDirs) {
		const dirFiles = files.filter(
			(f) => f.startsWith(dir + "/") || (dir === "(root)" && !f.includes("/")),
		);
		lines.push(`- \`${dir}/\` — ${dirFiles.length} files`);
	}

	lines.push("");
	lines.push("### Suggested Reading Order");
	lines.push("");
	if (topFiles.length > 0) {
		for (let i = 0; i < Math.min(5, topFiles.length); i++) {
			lines.push(`${i + 1}. Start with \`${topFiles[i]![0]}\``);
		}
	}

	// Add Next recommendations
	const nextItems = getNextForTool("overview", { topFile: topFiles[0]?.[0], topSymbol: topFiles[0]?.[1].topSym });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

export function executeOverviewJson(
	graph: RepoGraph,
	projectRoot: string,
	filter?: string,
): string {
	const files = filter
		? [...graph.fileSymbols.keys()].filter(
				(f) => !isNonSourceFile(f) && f.includes(filter),
			)
		: [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));

	const fileStats = new Map<string, { count: number; pagerank: number }>();
	for (const file of files) {
		const symIds = graph.fileSymbols.get(file);
		if (!symIds) continue;
		let totalPR = 0;
		for (const id of symIds) {
			totalPR += graph.symbols.get(id)?.pagerank ?? 0;
		}
		fileStats.set(file, { count: symIds.length, pagerank: totalPR });
	}

	const topFiles = [...fileStats.entries()]
		.sort((a, b) => b[1].pagerank - a[1].pagerank)
		.slice(0, 10);

	return JSON.stringify({
		schema_version: "1.0",
		command: "overview",
		project: projectRoot,
		status: "ok",
		result: {
			totalSymbols: graph.symbols.size,
			totalFiles: graph.fileSymbols.size,
			topFiles: topFiles.map(([file, stats]) => ({
				file,
				symbolCount: stats.count,
				pagerank: Number(stats.pagerank.toFixed(4)),
			})),
		},
	});
}

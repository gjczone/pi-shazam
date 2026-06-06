/**
 * pi-shazam tools/overview — Project structure summary.
 *
 * Includes HTTP route inventory (absorbed from tools/routes.ts).
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { isNonSourceFile } from "../core/filter.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool } from "./_factory.js";

// ── Route detection (absorbed from tools/routes.ts) ──────────────────────

const WEB_FRAMEWORK_INDICATORS = [
	"express",
	"fastify",
	"koa",
	"next",
	"nuxt",
	"hapi",
	"restify",
	"sveltekit",
	"remix",
	"hono",
	"elysia",
	"nestjs",
	"@nestjs/core",
];

const ROUTE_REGISTRATION_PATTERNS = [
	"app.get",
	"app.post",
	"app.put",
	"app.delete",
	"app.patch",
	"app.all",
	"app.use",
	"app.route",
	"router.get",
	"router.post",
	"router.put",
	"router.delete",
	"router.patch",
	"server.get",
	"server.post",
];

export function registerOverview(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_overview",
		label: "Project Overview",
		description: `\
MUST call before touching ANY code in an unfamiliar project or repo.
Returns: module dependency map, top-10 highest-PageRank files (the
"spine" of the codebase), entry points, suggested reading order, and
HTTP route inventory when a web framework is detected. Supports
--filter to search/find files by keyword within the project.
Skipping this = navigating blind — you WILL miss cross-module ripple
effects and waste turns on dead-end reads.

Scenario: first turn in a new repo. After git clone. After switching
to an unfamiliar project directory. Use --filter <keyword> to locate
specific files (replaces separate find_file tool).

Output: plain text summary by default. Pass { json: true } for
structured output with file lists and PageRank scores.`,
		params: Type.Object({
			filter: Type.Optional(Type.String()),
		}),
		execute(graph, params) {
			const filter = (params.filter as string) ?? "";
			const json = params.json ?? false;
			return json
				? executeOverviewJson(graph, ".", filter)
				: executeOverview(graph, ".", filter);
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

	// HTTP Routes section (absorbed from tools/routes.ts)
	// Only shown when no filter is active (routes are project-level)
	if (!filter) {
		const routesSection = buildRoutesSection(graph);
		if (routesSection) {
			lines.push("");
			lines.push(routesSection);
		}
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

// ── Route inventory (absorbed from tools/routes.ts) ─────────────────────

/**
 * Build a concise "HTTP Routes" section for the overview.
 * Returns null when no web framework is detected or no routes found.
 */
function buildRoutesSection(graph: RepoGraph): string | null {
	const framework = detectWebFramework(graph);
	if (!framework) return null;

	const routeSymbols = findRouteSymbols(graph);
	if (routeSymbols.length === 0) return null;

	const lines: string[] = [];
	lines.push(`### HTTP Routes (${framework} detected)`);
	lines.push("");

	// Group by file
	const byFile = new Map<string, Symbol[]>();
	for (const sym of routeSymbols) {
		const arr = byFile.get(sym.file) || [];
		arr.push(sym);
		byFile.set(sym.file, arr);
	}

	for (const [_file, syms] of [...byFile.entries()].sort()) {
		for (const sym of syms) {
			lines.push(
				`- ${sym.kind} \`${sym.name}\` L${sym.line} — ${sym.signature.slice(0, 80)}`,
			);
		}
	}

	return lines.join("\n");
}

/**
 * Full route inventory output (exported for backward-compatible testing).
 */
export function executeRoutes(graph: RepoGraph, _projectRoot: string): string {
	const lines: string[] = [];
	lines.push("## HTTP Route Inventory");
	lines.push("");

	const hasWebFramework = detectWebFramework(graph);
	if (!hasWebFramework) {
		lines.push("No web framework detected in this project.");
		lines.push("");
		lines.push(
			"Route inventory is only available for projects using recognized web frameworks.",
		);
		lines.push(
			`Supported frameworks: ${WEB_FRAMEWORK_INDICATORS.slice(0, 6).join(", ")}, etc.`,
		);
		lines.push("");
		lines.push(
			"If this project uses a web framework not in the supported list, route detection will not find routes.",
		);
		return lines.join("\n");
	}

	const routeSymbols = findRouteSymbols(graph);
	if (routeSymbols.length === 0) {
		lines.push(`Web framework detected (${hasWebFramework}), but no route registration patterns found.`);
		lines.push("");
		lines.push("This may mean:");
		lines.push("- Routes are defined in a non-standard way (factory pattern, decorators)");
		lines.push("- Routes are in a file not parsed by tree-sitter");
		lines.push("- The project imports the framework but doesn't register routes");
		return lines.join("\n");
	}

	lines.push(
		`Framework: **${hasWebFramework}** | Found ${routeSymbols.length} route-related symbols`,
	);
	lines.push("");

	const byFile = new Map<string, Symbol[]>();
	for (const sym of routeSymbols) {
		const arr = byFile.get(sym.file) || [];
		arr.push(sym);
		byFile.set(sym.file, arr);
	}

	for (const [file, syms] of [...byFile.entries()].sort()) {
		lines.push("");
		lines.push(`### ${file}`);
		for (const sym of syms) {
			lines.push(
				`- ${sym.kind} \`${sym.name}\` L${sym.line} — ${sym.signature.slice(0, 80)}`,
			);
		}
	}

	const nextItems = getNextForTool("overview", { handlerFile: routeSymbols[0]?.file });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

function detectWebFramework(graph: RepoGraph): string | null {
	for (const [, imports] of graph.fileImports) {
		for (const imp of imports) {
			const lower = imp.toLowerCase();
			for (const fw of WEB_FRAMEWORK_INDICATORS) {
				if (lower === fw || lower.startsWith(fw + "/") || lower.startsWith(fw + "-")) {
					return fw;
				}
			}
		}
	}
	return null;
}

function findRouteSymbols(graph: RepoGraph): Symbol[] {
	const results: Symbol[] = [];

	for (const sym of graph.symbols.values()) {
		const lower = sym.name.toLowerCase();

		for (const pattern of ROUTE_REGISTRATION_PATTERNS) {
			if (lower === pattern || lower.endsWith("." + pattern.split(".").pop()!)) {
				results.push(sym);
				break;
			}
		}

		if (lower.startsWith("handle") || lower.endsWith("handler") || lower.endsWith("controller")) {
			const isDuplicate = results.some((r) => r.id === sym.id);
			if (!isDuplicate) {
				results.push(sym);
			}
		}
	}

	return results;
}

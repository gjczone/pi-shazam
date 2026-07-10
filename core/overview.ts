/**
 * pi-shazam core/overview -- Project structure summary builder.
 *
 * Pure construction logic for shazam_overview: text and typed JSON result.
 * No Pi/LSP imports; sinks here from tools/overview.ts (issue #716) to keep
 * core independent of the tools layer. The Pi tool registration remains in
 * tools/overview.ts (registerOverview) and re-exports these symbols.
 *
 * Includes HTTP route inventory (absorbed from tools/routes.ts).
 */
import type { RepoGraph, Symbol } from "./graph.js";
import { isNonSourceFile } from "./filter.js";
import { getNextForTool, formatNextSection, _logWarn, buildEnvelope } from "./output.js";
import { getExcludedTestCount } from "./scanner.js";
import { EXT_TO_LANG, getProjectParserWarnings } from "./treesitter.js";
import { existsSync } from "node:fs";
import { readFileAdaptive } from "./encoding.js";
import { safeGitExec } from "./git-utils.js";
import { join } from "node:path";
import { topByRank, topByComplexity } from "./complexity.js";

// #629: symbol-level Hotspots (PageRank top-N + cyclomatic complexity top-N).
// Both lists surface the same `name::file:line (score)` shape so an LLM agent
// can scan either block uniformly.
const HOTSPOTS_TOP_N = 5;

// -- Route detection (absorbed from tools/routes.ts) ----------------------

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

export function executeOverview(graph: RepoGraph, projectRoot: string, filter?: string): string {
	return _buildOverviewText(graph, projectRoot, filter);
}

function _buildOverviewText(graph: RepoGraph, projectRoot: string, filter?: string): string {
	const lines: string[] = [];

	// -- Apply file filtering ---------------------------------------
	const files = filter
		? [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f) && f.includes(filter))
		: [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));

	if (files.length === 0) {
		lines.push("## Project Overview");
		lines.push("");
		lines.push(
			"No matching source files found. Try without --filter to see the full overview, or check the spelling of your filter keyword.",
		);
		return lines.join("\n");
	}

	// Summary stats
	lines.push("## Project Overview");
	lines.push("");
	lines.push(`${graph.symbols.size} symbols across ${files.length} source files`);

	// Issue #693: warn when the scan hit MAX_FILES and skipped files, so the
	// agent knows the graph (and any dependency results) may be incomplete.
	if (graph.truncated === true) {
		lines.push("");
		lines.push(
			"[WARNING] File count exceeded MAX_FILES — the analysis graph is incomplete. Results may miss dependencies.",
		);
	}

	// Language breakdown
	const langCounts = new Map<string, number>();
	for (const file of files) {
		const ext = "." + file.split(".").pop()?.toLowerCase();
		const lang = EXT_TO_LANG[ext];
		if (lang) {
			langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
		}
	}
	if (langCounts.size > 0) {
		lines.push("");
		lines.push("### Language Support");
		lines.push("");
		lines.push("Supported: " + [...langCounts.entries()].map(([l, c]) => `${l} (${c} files)`).join(", "));
		lines.push("");
		lines.push(
			"Note: Only Python, TypeScript, JavaScript, Go, Rust, Dart, and JSON are analyzed. Other file types are skipped.",
		);

		// Parser availability warning (follow-up to #349):
		// Only warn for languages that actually exist in the project and whose parser is unavailable.
		// A pure TS project won't see Dart warnings, avoiding indiscriminate broadcast noise.
		const unavailable = getProjectParserWarnings(graph.fileSymbols.keys());
		if (unavailable.length > 0) {
			lines.push("");
			lines.push("### Parser Availability Warning");
			lines.push("");
			for (const [lang, info] of unavailable) {
				const reason = info.reason ? ` (${info.reason})` : "";
				const suggestion = info.suggestion ? ` Suggestion: ${info.suggestion}` : "";
				lines.push(`- **${lang}**: tree-sitter parser unavailable${reason}.${suggestion}`);
			}
			lines.push("");
			lines.push(
				"Files in these languages will have 0 symbols in the graph. Use `shazam_lookup` and `shazam_verify` (LSP-based) for these files instead.",
			);
		}
	}

	// Key Dependencies and Recent Changes (only in full overview, not filter mode)
	if (!filter) {
		const depsSection = buildKeyDependenciesSection(projectRoot);
		if (depsSection) {
			lines.push("");
			lines.push(depsSection);
		}
		const pythonDeps = buildPythonDepsSection(projectRoot);
		if (pythonDeps) {
			lines.push("");
			lines.push(pythonDeps);
		}
		const rustDeps = buildRustDepsSection(projectRoot);
		if (rustDeps) {
			lines.push("");
			lines.push(rustDeps);
		}
		const goDeps = buildGoDepsSection(projectRoot);
		if (goDeps) {
			lines.push("");
			lines.push(goDeps);
		}
		const changesSection = buildRecentChangesSection(projectRoot);
		if (changesSection) {
			lines.push("");
			lines.push(changesSection);
		}
	}

	// Calculate per-file symbol counts, aggregate PageRank, and reference counts
	const fileStats = new Map<
		string,
		{ count: number; pagerank: number; topSym: string; incomingRefs: number; outgoingRefs: number }
	>();
	for (const file of files) {
		const symIds = graph.fileSymbols.get(file);
		if (!symIds) continue;
		let totalPR = 0;
		let topPR = 0;
		let topName = "";
		let incoming = 0;
		let outgoing = 0;
		for (const id of symIds) {
			const sym = graph.symbols.get(id);
			if (sym) {
				totalPR += sym.pagerank;
				if (sym.pagerank > topPR) {
					topPR = sym.pagerank;
					topName = sym.name;
				}
			}
			const inc = graph.incoming.get(id);
			if (inc) incoming += inc.length;
			const out = graph.outgoing.get(id);
			if (out) outgoing += out.length;
		}
		fileStats.set(file, {
			count: symIds.length,
			pagerank: totalPR,
			topSym: topName,
			incomingRefs: incoming,
			outgoingRefs: outgoing,
		});
	}

	// Top files by PageRank
	const topFiles = [...fileStats.entries()].sort((a, b) => b[1].pagerank - a[1].pagerank).slice(0, 10);

	lines.push("");
	lines.push("### Top 10 Files by PageRank");
	lines.push("");
	for (let i = 0; i < topFiles.length; i++) {
		const [file, stats] = topFiles[i]!;
		lines.push(
			`${i + 1}. \`${file}\` - ${stats.count} symbols, PageRank ${stats.pagerank.toFixed(4)}, top symbol: ${stats.topSym}`,
		);
	}

	// Key Data Structures (#491)
	if (!filter) {
		const dsSection = _buildDataStructuresSection(graph);
		if (dsSection) {
			lines.push("");
			lines.push(dsSection);
		}
	}

	// Entry points: auto-detected CLI / HTTP / event handlers (#489)
	if (!filter) {
		const entryPoints = _detectEntryPoints(graph);
		if (entryPoints.length > 0) {
			lines.push("");
			lines.push("### Entry Points");
			lines.push("");
			for (const ep of entryPoints) {
				const sig = ep.signature ? ` (\`${ep.signature.slice(0, 60)}\`)` : "";
				lines.push(`- \`${ep.category}\` **${ep.name}** — \`${ep.file}:${ep.line}\`${sig}`);
			}
		}
	}

	// Module dependency summary
	lines.push("");
	lines.push("### Module Structure");
	lines.push("");
	// Show 2 levels of directory depth for better project structure visibility
	const dirs = new Map<string, number>();
	for (const file of files) {
		if (!file.includes("/")) {
			dirs.set("(root)", (dirs.get("(root)") ?? 0) + 1);
		} else {
			const parts = file.split("/");
			const twoLevels = parts.slice(0, 2).join("/");
			dirs.set(twoLevels, (dirs.get(twoLevels) ?? 0) + 1);
		}
	}
	const sortedDirs = [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	for (const [dir, count] of sortedDirs) {
		const label = dir === "(root)" ? "(root)" : dir;
		const fileWord = count === 1 ? "file" : "files";
		lines.push(`- \`${label}\` - ${count} ${fileWord}`);
	}

	// #631 B: per-directory symbol density. The Module Density list
	// shows the top 10 directories by symbols-per-file ratio so an
	// LLM agent can spot "god modules" without paging through the
	// source tree.
	if (!filter) {
		const densities = _buildTopByDensity(graph, files, 10);
		if (densities.length > 0) {
			lines.push("");
			lines.push("### Module Density (Top 10 by symbols-per-file)");
			lines.push("");
			for (const d of densities) {
				lines.push(`- \`${d.dir}\` - ${d.symbols} symbols / ${d.files} files = ${d.ratio}`);
			}
		}
	}

	// Issue #632: when the default test-exclusion policy filtered out files,
	// surface the count here so LLM agents see the gap. Only render when the
	// count is non-zero -- a no-op footnote adds noise. Information follows
	// the same prefix conventions as other sections.
	const excludedCount = getExcludedTestCount(graph);
	if (excludedCount > 0) {
		lines.push("");
		lines.push(
			`Note: ${excludedCount} test file(s) excluded from graph (default policy). Set \`PI_SHAZAM_INCLUDE_TESTS=1\` to include them.`,
		);
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

	// Hotspots section (absorbed from tools/hotspots.ts)
	if (!filter) {
		const hotspots = _computeHotspots(graph, 10, fileStats);
		if (hotspots.length > 0) {
			lines.push("");
			lines.push("### Complexity Hotspots (Top 10)");
			lines.push("");
			lines.push("Ranked by symbol density x PageRank score.");
			lines.push("");
			for (let i = 0; i < hotspots.length; i++) {
				const h = hotspots[i]!;
				lines.push(`${i + 1}. \`${h.file}\` - score: ${h.hotspotScore.toFixed(2)}`);
				lines.push(
					`   ${h.symbolCount} symbols | PageRank: ${h.totalPagerank.toFixed(2)} | in:${h.incomingRefs} out:${h.outgoingRefs}`,
				);
			}
		}
	}

	// #629: symbol-level Hotspots -- always included so the LLM doesn't need
	// a follow-up `shazam_impact` to find the riskiest individual symbols.
	// Distinct from the file-level "Complexity Hotspots" above: this one
	// ranks individual symbols by PageRank and cyclomatic complexity.
	if (!filter) {
		const byRank = topByRank(graph, HOTSPOTS_TOP_N);
		const byComplexity = topByComplexity(graph, projectRoot, HOTSPOTS_TOP_N);
		if (byRank.length > 0 || byComplexity.length > 0) {
			lines.push("");
			lines.push("### Hotspots");
			lines.push("");
			if (byRank.length > 0) {
				lines.push(`#### By PageRank (top ${HOTSPOTS_TOP_N})`);
				lines.push("");
				for (let i = 0; i < byRank.length; i++) {
					const e = byRank[i]!;
					lines.push(`  ${i + 1}. \`${e.file}\`::${e.name} (${e.score})`);
				}
				lines.push("");
			}
			if (byComplexity.length > 0) {
				lines.push(`#### By complexity (top ${HOTSPOTS_TOP_N}, cyclomatic)`);
				lines.push("");
				for (let i = 0; i < byComplexity.length; i++) {
					const e = byComplexity[i]!;
					lines.push(`  ${i + 1}. \`${e.file}\`::${e.name} (${e.score})`);
				}
				lines.push("");
			}
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

export function executeOverviewJson(graph: RepoGraph, projectRoot: string, filter?: string): string {
	return buildEnvelope("shazam_overview", projectRoot, "ok", buildOverviewResult(graph, projectRoot, filter));
}

/**
 * #631 A: typed return value of shazam_overview. The dispatcher
 * (tools/_dispatchers.ts) wraps this object in buildEnvelope for
 * JSON mode; the existing executeOverview text path is unchanged
 * for backward compat with the test suite.
 *
 * `kind` discriminator for error / not_found cases (e.g. when a
 * filter matches no files, the result.kind is "empty" and the
 * renderer emits a friendly "no matching source files" message).
 */
export interface OverviewTopFile {
	file: string;
	symbolCount: number;
	pagerank: number;
}

export interface OverviewHotspot {
	file: string;
	name: string;
	score: number;
}

export interface OverviewResult {
	kind: "overview" | "empty";
	filter?: string;
	totalSymbols: number;
	totalFiles: number;
	excludedTests?: number;
	keyDependencies?: string;
	pythonDependencies?: string;
	rustDependencies?: string;
	goDependencies?: string;
	recentChanges?: string;
	topFiles: OverviewTopFile[];
	hotspots?: { byPageRank: OverviewHotspot[]; byComplexity: OverviewHotspot[] };
	/**
	 * Module density ranking (issue #631 B, slice 3.3). Top 10
	 * directories by symbols-per-file ratio -- surfaces "god
	 * module" candidates without paging through the source tree.
	 */
	topByDensity?: OverviewModuleDensity[];
	/**
	 * Sections previously rendered only in the text view (issue #662). JSON
	 * and text modes must expose the same signals so MCP/LLM consumers do
	 * not silently lose the "where to start / blast radius" guidance.
	 */
	dataStructures?: string | null;
	entryPoints?: OverviewEntryPoint[];
	httpRoutes?: string | null;
	complexityHotspots?: OverviewFileHotspot[];
	suggestedReadingOrder?: string[];
	parserWarnings?: OverviewParserWarning[];
	moduleStructure?: OverviewModuleNode[];
	/** Issue #693: true when the scan hit MAX_FILES and skipped source files. */
	truncated?: boolean;
}

export interface OverviewModuleDensity {
	dir: string;
	files: number;
	symbols: number;
	ratio: number;
}

/** A detected entry point (CLI / HTTP / event handler). Exposed in JSON so
 * MCP/LLM consumers get the same "where to start" signal as the text view. */
export interface OverviewEntryPoint {
	category: "cli" | "http" | "event";
	name: string;
	file: string;
	line: number;
	signature: string;
}

/** A file-level complexity hotspot. Exposed in JSON alongside the
 * symbol-level `hotspots` field for full parity with the text view. */
export interface OverviewFileHotspot {
	file: string;
	symbolCount: number;
	totalPagerank: number;
	incomingRefs: number;
	outgoingRefs: number;
	hotspotScore: number;
}

/** Parser-availability warning entry (language whose tree-sitter parser is
 * unavailable in this environment). */
export interface OverviewParserWarning {
	language: string;
	reason?: string;
	suggestion?: string;
}

/** A directory node in the module-structure tree. */
export interface OverviewModuleNode {
	dir: string;
	files: number;
}

/**
 * #631 A: build the typed OverviewResult. Single source of truth
 * for the JSON envelope; previously the shape was inlined in
 * executeOverviewJson.
 */
export function buildOverviewResult(graph: RepoGraph, projectRoot: string, filter?: string): OverviewResult {
	const files = filter
		? [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f) && f.includes(filter))
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

	const topFiles = [...fileStats.entries()].sort((a, b) => b[1].pagerank - a[1].pagerank).slice(0, 10);

	const excludedTests = getExcludedTestCount(graph);

	// #629: symbol-level hotspots always present in JSON so agents get the
	// data without parsing the text output. Skipped when a filter is active
	// (filtered overview is scoped to a keyword, not project-wide hotspots).
	const hotspots = filter
		? undefined
		: {
				byPageRank: topByRank(graph, HOTSPOTS_TOP_N),
				byComplexity: topByComplexity(graph, projectRoot, HOTSPOTS_TOP_N),
			};

	// #631 B (slice 3.3): compute per-directory symbol density
	// (symbols / files). Surfaces "god module" candidates without
	// having to scan the full source tree. The directory is the
	// first two path segments, matching the "Module Structure" view
	// in the markdown output. Skipped when a filter is active.
	const topByDensity = filter ? undefined : _buildTopByDensity(graph, files, 10);

	return {
		kind: files.length === 0 ? "empty" : "overview",
		filter,
		totalSymbols: graph.symbols.size,
		totalFiles: graph.fileSymbols.size,
		excludedTests: excludedTests > 0 ? excludedTests : undefined,
		keyDependencies: filter ? undefined : (buildKeyDependenciesSection(projectRoot) ?? undefined),
		pythonDependencies: filter ? undefined : (buildPythonDepsSection(projectRoot) ?? undefined),
		rustDependencies: filter ? undefined : (buildRustDepsSection(projectRoot) ?? undefined),
		goDependencies: filter ? undefined : (buildGoDepsSection(projectRoot) ?? undefined),
		recentChanges: filter ? undefined : (buildRecentChangesSection(projectRoot) ?? undefined),
		topFiles: topFiles.map(([file, stats]) => ({
			file,
			symbolCount: stats.count,
			pagerank: Number(stats.pagerank.toFixed(4)),
		})),
		hotspots,
		topByDensity,
		// Sections previously text-only (issue #662): mirror the text builder
		// so JSON and text modes expose the same signals.
		dataStructures: filter ? undefined : _buildDataStructuresSection(graph),
		entryPoints: filter ? undefined : _detectEntryPoints(graph),
		httpRoutes: filter ? undefined : buildRoutesSection(graph),
		truncated: graph.truncated === true ? true : undefined,
		complexityHotspots: filter ? undefined : _computeHotspots(graph, 10),
		suggestedReadingOrder: filter ? undefined : topFiles.slice(0, 5).map(([file]) => file),
		parserWarnings: filter ? undefined : _buildParserWarnings(graph),
		moduleStructure: filter ? undefined : _buildModuleStructure(files),
	};
}

/**
 * Build the parser-availability warnings (issue #662) for the JSON result,
 * mirroring the "Parser Availability Warning" section of the text view.
 * Only languages the project actually uses but whose parser is unavailable.
 */
function _buildParserWarnings(graph: RepoGraph): OverviewParserWarning[] {
	const unavailable = getProjectParserWarnings(graph.fileSymbols.keys());
	return unavailable.map(([lang, info]) => ({
		language: lang,
		reason: info.reason,
		suggestion: info.suggestion,
	}));
}

/**
 * Build the module-structure directory tree (issue #662) for the JSON
 * result, mirroring the "Module Structure" section of the text view.
 * Two levels of directory depth, sorted alphabetically.
 */
function _buildModuleStructure(files: string[]): OverviewModuleNode[] {
	const dirs = new Map<string, number>();
	for (const file of files) {
		// Normalize Windows backslash paths so the two-level grouping and the
		// "(root)" check behave identically across platforms (issue #662).
		const normalized = file.replace(/\\/g, "/");
		if (!normalized.includes("/")) {
			dirs.set("(root)", (dirs.get("(root)") ?? 0) + 1);
		} else {
			const parts = normalized.split("/");
			const twoLevels = parts.slice(0, 2).join("/");
			dirs.set(twoLevels, (dirs.get(twoLevels) ?? 0) + 1);
		}
	}
	return [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, count]) => ({ dir, files: count }));
}

/**
 * #631 B: rank directories by symbols-per-file ratio. The directory
 * for a file is its first two path segments ("(root)" for top-level
 * files); this matches the grouping used in the markdown "Module
 * Structure" section so the JSON field and the text view agree.
 */
function _buildTopByDensity(graph: RepoGraph, files: string[], topN: number): OverviewModuleDensity[] {
	const dirStats = new Map<string, { files: number; symbols: number }>();
	for (const file of files) {
		const normalized = file.replace(/\\/g, "/");
		const dir = normalized.includes("/") ? normalized.split("/").slice(0, 2).join("/") : "(root)";
		const symCount = graph.fileSymbols.get(file)?.length ?? 0;
		const existing = dirStats.get(dir) ?? { files: 0, symbols: 0 };
		existing.files += 1;
		existing.symbols += symCount;
		dirStats.set(dir, existing);
	}
	const result: OverviewModuleDensity[] = [];
	for (const [dir, stats] of dirStats) {
		if (stats.files === 0) continue;
		result.push({
			dir,
			files: stats.files,
			symbols: stats.symbols,
			ratio: Number((stats.symbols / stats.files).toFixed(2)),
		});
	}
	result.sort((a, b) => b.ratio - a.ratio);
	return result.slice(0, topN);
}

// -- Entry point detection (#489) ---------------------------------------

interface EntryPoint {
	category: "cli" | "http" | "event";
	name: string;
	file: string;
	line: number;
	signature: string;
}

/**
 * Detect entry points from the symbol graph using name and kind heuristics.
 * Covers CLI main functions (Python, Go, Rust, Dart), JS/TS event listeners,
 * and delegates HTTP routes to the existing route detection.
 */
export function _detectEntryPoints(graph: RepoGraph): EntryPoint[] {
	const results: EntryPoint[] = [];
	const seen = new Set<string>();

	for (const sym of graph.symbols.values()) {
		const lang = EXT_TO_LANG["." + (sym.file.split(".").pop()?.toLowerCase() ?? "")] ?? "unknown";

		// CLI: functions named "main" at file level
		// Covers: Python def main(), Go func main(), Rust fn main(), Dart void main()
		if (sym.kind === "function" && sym.name === "main") {
			const key = `cli::${sym.id}`;
			if (!seen.has(key)) {
				seen.add(key);
				results.push({
					category: "cli",
					name: sym.name,
					file: sym.file,
					line: sym.line,
					signature: sym.signature,
				});
			}
		}

		// CLI: Python decorators indicating CLI frameworks
		// click.command, click.group, typer commands
		if (lang === "python" && (sym.name === "command" || sym.name === "group" || sym.name === "cli")) {
			// These are often created via @click.command() etc., listed as top-level symbols
			if (sym.visibility === "exported" || sym.kind === "function") {
				const key = `cli::${sym.id}`;
				if (!seen.has(key)) {
					seen.add(key);
					results.push({
						category: "cli",
						name: sym.name,
						file: sym.file,
						line: sym.line,
						signature: sym.signature,
					});
				}
			}
		}

		// Event: JS/TS event listeners and message handlers
		if (
			(lang === "javascript" || lang === "typescript" || lang === "tsx") &&
			(sym.name.startsWith("on") ||
				sym.name.includes("Listener") ||
				sym.name.includes("Handler") ||
				sym.name.includes("Event"))
		) {
			const key = `event::${sym.id}`;
			if (!seen.has(key)) {
				seen.add(key);
				results.push({
					category: "event",
					name: sym.name,
					file: sym.file,
					line: sym.line,
					signature: sym.signature,
				});
			}
		}
	}

	// Sort: cli first, then http, then event; within each, by PageRank (implicitly by insertion order from graph iteration)
	results.sort((a, b) => {
		const catOrder: Record<string, number> = { cli: 0, http: 1, event: 2 };
		return (catOrder[a.category] ?? 9) - (catOrder[b.category] ?? 9);
	});

	// Limit to top 15 to avoid output bloat
	return results.slice(0, 15);
}

// -- Route inventory (absorbed from tools/routes.ts) ---------------------

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
			lines.push(`- ${sym.kind} \`${sym.name}\` L${sym.line} - ${sym.signature.slice(0, 80)}`);
		}
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

// -- Key Dependencies section ----------------------------------------

/**
 * Build a "Key Dependencies" section for the overview.
 * Reads package.json and extracts dependencies + devDependencies (top 15).
 * Returns null when no package.json is found.
 */
export function buildKeyDependenciesSection(projectRoot: string): string | null {
	try {
		const pkgPath = join(projectRoot, "package.json");
		if (!existsSync(pkgPath)) return null;
		const raw = readFileAdaptive(pkgPath);
		const pkg = JSON.parse(raw);
		const lines: string[] = [];
		lines.push("### Key Dependencies");
		lines.push("");

		const deps = Object.entries(pkg.dependencies ?? {});
		const devDeps = Object.entries(pkg.devDependencies ?? {});

		if (deps.length === 0 && devDeps.length === 0) {
			lines.push("(none)");
			return lines.join("\n");
		}

		// Show top 15 dependencies (deps first, then devDeps)
		const all = [
			...deps.map(([name, ver]) => ({ name, version: ver as string, type: "dep" })),
			...devDeps.map(([name, ver]) => ({ name, version: ver as string, type: "devDep" })),
		].slice(0, 15);

		lines.push("| Package | Version | Type |");
		lines.push("|---------|---------|------|");
		for (const d of all) {
			lines.push(`| ${d.name} | ${d.version} | ${d.type} |`);
		}

		return lines.join("\n");
	} catch (err) {
		_logWarn("buildKeyDependenciesSection", `failed to read package.json for ${projectRoot}`, err);
		return null;
	}
}

/**
 * Build a Python dependencies section for the overview.
 * Reads pyproject.toml or falls back to requirements.txt.
 * Returns null when neither file is found.
 */
function buildPythonDepsSection(projectRoot: string): string | null {
	const lines: string[] = [];
	lines.push("### Key Python Dependencies");
	lines.push("");

	// Try pyproject.toml first
	const pyprojectPath = join(projectRoot, "pyproject.toml");
	if (existsSync(pyprojectPath)) {
		try {
			const content = readFileAdaptive(pyprojectPath);
			const depsMatch = content.match(/\[project\.dependencies\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/);
			if (depsMatch) {
				const deps = depsMatch[1]!.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
				lines.push("| Package | Version |");
				lines.push("|---------|---------|");
				for (const dep of deps.slice(0, 15)) {
					const match = dep.match(/^"?([^"<>=]+)"?\s*[<>=]?\s*"?([^"]*)"?/);
					if (match) lines.push(`| ${match[1]!.trim()} | ${match[2]?.trim() || ""} |`);
				}
				return lines.join("\n");
			}
		} catch (err) {
			_logWarn("buildPythonDepsSection", `failed to read pyproject.toml for ${projectRoot}`, err);
			/* ignore */
		}
	}

	// Fallback: requirements.txt
	const reqPath = join(projectRoot, "requirements.txt");
	if (existsSync(reqPath)) {
		try {
			const content = readFileAdaptive(reqPath);
			const deps = content.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("-"));
			lines.push("| Package |");
			lines.push("|---------|");
			for (const dep of deps.slice(0, 15)) {
				lines.push(`| ${dep.trim()} |`);
			}
			return lines.join("\n");
		} catch (err) {
			_logWarn("buildPythonDepsSection", `failed to read requirements.txt for ${projectRoot}`, err);
			/* ignore */
		}
	}

	return null;
}

/**
 * Build a Rust dependencies section for the overview.
 * Reads Cargo.toml and extracts [dependencies].
 * Returns null when no Cargo.toml is found.
 */
function buildRustDepsSection(projectRoot: string): string | null {
	const cargoPath = join(projectRoot, "Cargo.toml");
	if (!existsSync(cargoPath)) return null;
	try {
		const content = readFileAdaptive(cargoPath);
		const depsMatch = content.match(/\[dependencies\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/);
		if (!depsMatch) return null;
		const deps = depsMatch[1]!.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
		const lines: string[] = ["### Key Rust Dependencies", "", "| Crate | Version |", "|-------|---------|"];
		for (const dep of deps.slice(0, 15)) {
			const match = dep.match(/^"?([^"<>= ]+)"?\s*=\s*"?([^"]*)"?/);
			if (match) lines.push(`| ${match[1]!.trim()} | ${match[2]?.trim() || ""} |`);
		}
		return lines.join("\n");
	} catch (err) {
		_logWarn("buildRustDepsSection", `failed to read Cargo.toml for ${projectRoot}`, err);
		return null;
	}
}

/**
 * Build a Go dependencies section for the overview.
 * Reads go.mod and extracts require blocks.
 * Returns null when no go.mod is found.
 */
function buildGoDepsSection(projectRoot: string): string | null {
	const goModPath = join(projectRoot, "go.mod");
	if (!existsSync(goModPath)) return null;
	try {
		const content = readFileAdaptive(goModPath);
		const deps = content.split("\n").filter((l) => l.trim().startsWith("\t") && !/^\s*go\s+\d/.test(l));
		const lines: string[] = ["### Key Go Dependencies", "", "| Module | Version |", "|--------|---------|"];
		for (const dep of deps.slice(0, 15)) {
			const parts = dep.trim().split(/\s+/);
			if (parts.length >= 2) lines.push(`| ${parts[0]} | ${parts[1]} |`);
		}
		return lines.join("\n");
	} catch (err) {
		_logWarn("buildGoDepsSection", `failed to read go.mod for ${projectRoot}`, err);
		return null;
	}
}

// -- Recent Changes section ------------------------------------------

/**
 * Build a "Recent Changes" section for the overview.
 * Runs `git log --oneline -10` in the project root.
 * Returns null when git is not available or the command fails.
 */
export function buildRecentChangesSection(projectRoot: string): string | null {
	const stdout = safeGitExec(["log", "--oneline", "-10"], projectRoot, 5000);
	if (!stdout) return null;

	const commits = stdout.split("\n").filter(Boolean);
	const lines: string[] = [];
	lines.push("### Recent Changes");
	lines.push("");
	for (const c of commits) {
		lines.push(`- ${c}`);
	}

	return lines.join("\n");
}

// -- Data Structures section (#491) -----------------------------------

/**
 * Symbol kinds that represent data structures (not executable code).
 * Per-language mapping from tree-sitter kinds to display-friendly names.
 */
const DATA_STRUCTURE_KINDS = new Set([
	// Python
	"class",
	"dataclass",
	// TypeScript / JavaScript
	"interface",
	"type_alias",
	"enum",
	// Go
	"struct",
	// Rust
	"trait",
	// Dart
	"mixin",
	"extension",
]);

/** Number of top data structures to show per language. */
const DATA_STRUCTURES_TOP_N = 10;

/**
 * Build a "Key Data Structures" section showing the project's core types
 * across all languages, sorted by PageRank.
 */
export function _buildDataStructuresSection(graph: RepoGraph): string | null {
	const dataSyms = [...graph.symbols.values()].filter((s) => DATA_STRUCTURE_KINDS.has(s.kind));
	if (dataSyms.length === 0) return null;

	// Sort by PageRank descending, then by name ascending for stability
	const top = dataSyms
		.sort((a, b) => {
			if (b.pagerank !== a.pagerank) return b.pagerank - a.pagerank;
			return a.name.localeCompare(b.name);
		})
		.slice(0, DATA_STRUCTURES_TOP_N);

	const lines: string[] = [];
	lines.push("### Key Data Structures");
	lines.push("");
	lines.push("| Kind | Name | File | Description |");
	lines.push("|------|------|------|-------------|");

	for (const sym of top) {
		// Truncate docstring to first sentence or ~80 chars
		const desc = sym.docstring ? sym.docstring.split(".")[0]!.slice(0, 80).trim() : "-";
		lines.push(`| ${sym.kind} | \`${sym.name}\` | \`${sym.file}:${sym.line}\` | ${desc} |`);
	}

	return lines.join("\n");
}

// -- Hotspots (absorbed from tools/hotspots.ts) -------------------------

interface FileHotspot {
	file: string;
	symbolCount: number;
	totalPagerank: number;
	incomingRefs: number;
	outgoingRefs: number;
	hotspotScore: number;
}

export function _computeHotspots(
	graph: RepoGraph,
	topN: number,
	precomputed?: Map<string, { count: number; pagerank: number; incomingRefs: number; outgoingRefs: number }>,
): FileHotspot[] {
	const hotspots: FileHotspot[] = [];

	if (precomputed) {
		// Reuse precomputed fileStats from _buildOverviewText
		for (const [file, stats] of precomputed) {
			if (isNonSourceFile(file)) continue;
			hotspots.push({
				file,
				symbolCount: stats.count,
				totalPagerank: stats.pagerank,
				incomingRefs: stats.incomingRefs,
				outgoingRefs: stats.outgoingRefs,
				hotspotScore: stats.count * stats.pagerank,
			});
		}
	} else {
		// Standalone mode (executeHotspots): compute from scratch
		for (const [file, symIds] of graph.fileSymbols) {
			if (isNonSourceFile(file)) continue;

			let totalPR = 0;
			let incoming = 0;
			let outgoing = 0;

			for (const id of symIds) {
				const sym = graph.symbols.get(id);
				if (sym) totalPR += sym.pagerank;
				const inc = graph.incoming.get(id);
				if (inc) incoming += inc.length;
				const out = graph.outgoing.get(id);
				if (out) outgoing += out.length;
			}

			hotspots.push({
				file,
				symbolCount: symIds.length,
				totalPagerank: totalPR,
				incomingRefs: incoming,
				outgoingRefs: outgoing,
				hotspotScore: symIds.length * totalPR,
			});
		}
	}

	return hotspots.sort((a, b) => b.hotspotScore - a.hotspotScore).slice(0, topN);
}

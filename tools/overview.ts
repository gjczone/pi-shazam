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
import { buildEnvelope } from "./_factory.js";
import { EXT_TO_LANG, getProjectParserWarnings } from "../core/treesitter.js";
import { existsSync, readFileSync } from "node:fs";
import { safeGitExec } from "../core/git-utils.js";
import { join } from "node:path";

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
		When you first enter a project or return after changes — use this to
		understand the codebase before reading a single file. Returns: module
		dependency map, top-10 highest-PageRank files (the "spine"), key
		dependencies, recent git changes, entry points, reading order, HTTP
		route inventory, and complexity hotspots ranked by blast radius.
		Supports --filter to locate files by keyword.

		Output: plain text summary by default. Pass { json: true } for
		structured output with file lists and PageRank scores.`,
		params: Type.Object({
			filter: Type.Optional(Type.String()),
		}),
		execute(graph, params) {
			const filter = (params.filter as string) ?? "";
			const json = params.json ?? false;
			const projectRoot = (params.project as string) || ".";
			return json ? executeOverviewJson(graph, projectRoot, filter) : executeOverview(graph, projectRoot, filter);
		},
	});
}

export function executeOverview(graph: RepoGraph, projectRoot: string, filter?: string): string {
	return _buildOverviewText(graph, projectRoot, filter);
}

function _buildOverviewText(graph: RepoGraph, projectRoot: string, filter?: string): string {
	const lines: string[] = [];

	// ── Apply file filtering ───────────────────────────────────────
	const files = filter
		? [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f) && f.includes(filter))
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
	lines.push(`${graph.symbols.size} symbols across ${files.length} source files`);

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

		// Parser 可用性警告（follow-up to #349）：
		// 只对项目中实际存在且 parser 不可用的语言发出警告。
		// 纯 TS 项目不会看到 Dart 警告，避免无差别广播噪音。
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

	// Calculate per-file symbol counts and aggregate PageRank
	const fileStats = new Map<string, { count: number; pagerank: number; topSym: string }>();
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
	const topFiles = [...fileStats.entries()].sort((a, b) => b[1].pagerank - a[1].pagerank).slice(0, 10);

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
			lines.push(`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (PR ${sym.pagerank.toFixed(3)})`);
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
		const label = dir === "(root)" ? "(root)/" : `${dir}/`;
		lines.push(`- \`${label}\` — ${count} files`);
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
		const hotspots = _computeHotspots(graph, 10);
		if (hotspots.length > 0) {
			lines.push("");
			lines.push("### Complexity Hotspots (Top 10)");
			lines.push("");
			lines.push("Ranked by symbol density x PageRank score.");
			lines.push("");
			for (let i = 0; i < hotspots.length; i++) {
				const h = hotspots[i]!;
				lines.push(`${i + 1}. \`${h.file}\` — score: ${h.hotspotScore.toFixed(2)}`);
				lines.push(
					`   ${h.symbolCount} symbols | PageRank: ${h.totalPagerank.toFixed(2)} | in:${h.incomingRefs} out:${h.outgoingRefs}`,
				);
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

	return buildEnvelope("shazam_overview", projectRoot, "ok", {
		totalSymbols: graph.symbols.size,
		totalFiles: graph.fileSymbols.size,
		keyDependencies: filter ? undefined : buildKeyDependenciesSection(projectRoot),
		pythonDependencies: filter ? undefined : buildPythonDepsSection(projectRoot),
		rustDependencies: filter ? undefined : buildRustDepsSection(projectRoot),
		goDependencies: filter ? undefined : buildGoDepsSection(projectRoot),
		recentChanges: filter ? undefined : buildRecentChangesSection(projectRoot),
		topFiles: topFiles.map(([file, stats]) => ({
			file,
			symbolCount: stats.count,
			pagerank: Number(stats.pagerank.toFixed(4)),
		})),
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
			lines.push(`- ${sym.kind} \`${sym.name}\` L${sym.line} — ${sym.signature.slice(0, 80)}`);
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
		lines.push("Route inventory is only available for projects using recognized web frameworks.");
		lines.push(`Supported frameworks: ${WEB_FRAMEWORK_INDICATORS.slice(0, 6).join(", ")}, etc.`);
		lines.push("");
		lines.push("If this project uses a web framework not in the supported list, route detection will not find routes.");
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

	lines.push(`Framework: **${hasWebFramework}** | Found ${routeSymbols.length} route-related symbols`);
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
			lines.push(`- ${sym.kind} \`${sym.name}\` L${sym.line} — ${sym.signature.slice(0, 80)}`);
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

// ── Key Dependencies section ────────────────────────────────────────

/**
 * Build a "Key Dependencies" section for the overview.
 * Reads package.json and extracts dependencies + devDependencies (top 15).
 * Returns null when no package.json is found.
 */
export function buildKeyDependenciesSection(projectRoot: string): string | null {
	try {
		const pkgPath = join(projectRoot, "package.json");
		const raw = readFileSync(pkgPath, "utf-8");
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
	} catch {
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
	lines.push("### Key Dependencies");
	lines.push("");

	// Try pyproject.toml first
	const pyprojectPath = join(projectRoot, "pyproject.toml");
	if (existsSync(pyprojectPath)) {
		try {
			const content = readFileSync(pyprojectPath, "utf-8");
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
		} catch {
			/* ignore */
		}
	}

	// Fallback: requirements.txt
	const reqPath = join(projectRoot, "requirements.txt");
	if (existsSync(reqPath)) {
		try {
			const content = readFileSync(reqPath, "utf-8");
			const deps = content.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("-"));
			lines.push("| Package |");
			lines.push("|---------|");
			for (const dep of deps.slice(0, 15)) {
				lines.push(`| ${dep.trim()} |`);
			}
			return lines.join("\n");
		} catch {
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
		const content = readFileSync(cargoPath, "utf-8");
		const depsMatch = content.match(/\[dependencies\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/);
		if (!depsMatch) return null;
		const deps = depsMatch[1]!.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
		const lines: string[] = ["### Key Dependencies", "", "| Crate | Version |", "|-------|---------|"];
		for (const dep of deps.slice(0, 15)) {
			const match = dep.match(/^"?([^"<>= ]+)"?\s*=\s*"?([^"]*)"?/);
			if (match) lines.push(`| ${match[1]!.trim()} | ${match[2]?.trim() || ""} |`);
		}
		return lines.join("\n");
	} catch {
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
		const content = readFileSync(goModPath, "utf-8");
		const deps = content.split("\n").filter((l) => l.trim().startsWith("\t") && !l.includes("go "));
		const lines: string[] = ["### Key Dependencies", "", "| Module | Version |", "|--------|---------|"];
		for (const dep of deps.slice(0, 15)) {
			const parts = dep.trim().split(/\s+/);
			if (parts.length >= 2) lines.push(`| ${parts[0]} | ${parts[1]} |`);
		}
		return lines.join("\n");
	} catch {
		return null;
	}
}

// ── Recent Changes section ──────────────────────────────────────────

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

// ── Hotspots (absorbed from tools/hotspots.ts) ─────────────────────────

interface FileHotspot {
	file: string;
	symbolCount: number;
	totalPagerank: number;
	incomingRefs: number;
	outgoingRefs: number;
	hotspotScore: number;
}

function _computeHotspots(graph: RepoGraph, topN: number): FileHotspot[] {
	const fileStats = new Map<string, FileHotspot>();

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

		fileStats.set(file, {
			file,
			symbolCount: symIds.length,
			totalPagerank: totalPR,
			incomingRefs: incoming,
			outgoingRefs: outgoing,
			hotspotScore: symIds.length * totalPR,
		});
	}

	return [...fileStats.values()].sort((a, b) => b.hotspotScore - a.hotspotScore).slice(0, topN);
}

// ── Backward-compatible exports (for hotspots tests) ───────────────────

export function executeHotspots(graph: RepoGraph, topN: number = 10): string {
	const hotspots = _computeHotspots(graph, topN);
	const lines: string[] = [];
	lines.push(`## Complexity Hotspots (Top ${topN})`);
	lines.push("");
	lines.push("Ranked by symbol density x PageRank score.");
	lines.push("");
	for (let i = 0; i < hotspots.length; i++) {
		const h = hotspots[i]!;
		lines.push(`${i + 1}. \`${h.file}\` — score: ${h.hotspotScore.toFixed(2)}`);
		lines.push(
			`   ${h.symbolCount} symbols | PageRank: ${h.totalPagerank.toFixed(2)} | in:${h.incomingRefs} out:${h.outgoingRefs}`,
		);
		lines.push("");
	}
	return lines.join("\n");
}

export function executeHotspotsJson(graph: RepoGraph, topN: number): string {
	const hotspots = _computeHotspots(graph, topN);
	return buildEnvelope("shazam_overview", process.cwd(), "ok", {
		hotspots: hotspots.map((h) => ({
			file: h.file,
			symbolCount: h.symbolCount,
			totalPagerank: Number(h.totalPagerank.toFixed(4)),
			incomingRefs: h.incomingRefs,
			outgoingRefs: h.outgoingRefs,
			hotspotScore: Number(h.hotspotScore.toFixed(2)),
		})),
	});
}

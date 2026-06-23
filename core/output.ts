/**
 * pi-shazam core/output -- Standardized tool output formatting.
 *
 * All tool outputs follow a three-section skeleton:
 *   1. ## Result Summary (key-value table / quick summary)
 *   2. ### Detail (per-item expansion)
 *   3. ### Next (actionable tool recommendations)
 *
 * This module provides builders for each section. The Next recommendation
 * system is driven by a declarative rule array (NEXT_RULES) -- adding a
 * new tool = adding rules, not editing a switch. Rules can evaluate against
 * the RepoGraph to suppress irrelevant recommendations (e.g., no find_tests
 * when project has zero test files).
 */

import type { RepoGraph } from "./graph.js";
import { getGraphEdgeCount } from "./graph.js";
import { execSync } from "node:child_process";

// -- Next recommendation system --------------------------------------------

export type NextLevel = "required" | "recommended" | "also";

export interface NextRecommendation {
	tool: string;
	params?: Record<string, string | number | boolean>;
	label: string;
	level: NextLevel;
}

/**
 * Runtime context passed by each tool when asking for Next recommendations.
 * Fields are optional -- rules check only what they need.
 */
export interface NextContext {
	topFile?: string;
	topSymbol?: string;
	hasErrors?: boolean;
	hasFixes?: boolean;
	riskLevel?: string;
	orphanCount?: number;
	testFunc?: string;
	handlerFile?: string;
	usageFile?: string;
	brokenFile?: string;
}

/**
 * Declarative rule: for a set of tools, when condition holds, emit
 * recommendation. The recommendation is a factory so it can read context
 * (e.g., substitute topFile into --file).
 *
 * - `forTools`: tool names this rule applies to
 * - `condition`: returns true to emit; receives context + optional graph.
 *   When graph is undefined (legacy callers), graph-aware rules must
 *   short-circuit to preserve backward-compatible output.
 * - `recommendation`: factory returning the recommendation, or null to skip.
 */
export interface NextRule {
	forTools: string[];
	condition: (ctx: NextContext, graph?: RepoGraph) => boolean;
	recommendation: (ctx: NextContext) => NextRecommendation | null;
}

// -- Graph-aware filter helpers -----------------------------------------------

const TEST_FILE_PATTERNS = [
	/(?:^|[/.])tests?\//,
	/(?:^|[/.])__tests__\//,
	/\.test\.[a-z]+$/,
	/\.spec\.[a-z]+$/,
	/(?:^|[/.])test_[a-z_]+\.[a-z]+$/,
];

/**
 * True when the graph has at least one file matching test-file heuristics.
 */
export function hasTestFiles(graph?: RepoGraph): boolean {
	if (!graph) return false;
	for (const file of graph.fileSymbols.keys()) {
		for (const pat of TEST_FILE_PATTERNS) {
			if (pat.test(file)) return true;
		}
	}
	return false;
}

const HIERARCHY_KINDS = new Set(["class", "interface", "type_alias", "struct"]);

/**
 * True when the graph contains at least one class/interface/type_alias symbol.
 */
export function hasHierarchyKinds(graph?: RepoGraph): boolean {
	if (!graph) return false;
	for (const sym of graph.symbols.values()) {
		if (HIERARCHY_KINDS.has(sym.kind)) return true;
	}
	return false;
}

// -- Rules --------------------------------------------------------------------

/**
 * The single source of truth for Next recommendations. Each rule is a pure
 * function of (context, optional graph). To add a recommendation for a new
 * tool: append a rule here. No switch to edit.
 */
export const NEXT_RULES: NextRule[] = [
	// overview
	{
		forTools: ["overview"],
		condition: (ctx) => Boolean(ctx.topFile),
		recommendation: (ctx) => ({
			tool: "lookup",
			params: { name: ctx.topFile! },
			label: "Inspect top file",
			level: "recommended",
		}),
	},
	{
		forTools: ["overview"],
		condition: (_ctx, graph) => graph === undefined || hasTestFiles(graph),
		recommendation: () => ({
			tool: "find_tests",
			label: "Discover test layout",
			level: "also",
		}),
	},
	{
		forTools: ["overview"],
		condition: (_ctx, graph) => graph === undefined || hasHierarchyKinds(graph),
		recommendation: () => ({
			tool: "lookup",
			params: { name: "<type-name>" },
			label: "Explore type hierarchy",
			level: "also",
		}),
	},

	// lookup (replaces symbol, file_detail, hover, type_hierarchy)
	{
		forTools: ["lookup"],
		condition: (ctx) => Boolean(ctx.topSymbol),
		recommendation: (ctx) => ({
			tool: "impact",
			params: { symbol: ctx.topSymbol! },
			label: "Trace call chain",
			level: "recommended",
		}),
	},
	{
		forTools: ["lookup"],
		condition: (_ctx, graph) => graph === undefined || hasTestFiles(graph),
		recommendation: () => ({
			tool: "find_tests",
			label: "Find related tests",
			level: "also",
		}),
	},

	// impact (replaces call_chain)
	{
		forTools: ["impact"],
		condition: () => true,
		recommendation: () => ({
			tool: "verify",
			label: "Run verification after changes",
			level: "required",
		}),
	},
	{
		forTools: ["impact"],
		condition: (ctx) => Boolean(ctx.topSymbol),
		recommendation: (ctx) => ({
			tool: "lookup",
			params: { name: ctx.topSymbol! },
			label: "Inspect impacted symbol",
			level: "recommended",
		}),
	},

	// verify
	{
		forTools: ["verify"],
		condition: (ctx) => Boolean(ctx.orphanCount && ctx.orphanCount > 0),
		recommendation: () => ({
			tool: "impact",
			params: { symbol: "<orphan>" },
			label: "Trace orphan symbols",
			level: "recommended",
		}),
	},
	{
		forTools: ["verify"],
		condition: (ctx) => Boolean(ctx.hasErrors || ctx.hasFixes),
		recommendation: () => ({
			tool: "format",
			label: "Auto-fix format errors",
			level: "recommended",
		}),
	},

	// changes
	{
		forTools: ["changes"],
		condition: () => true,
		recommendation: () => ({
			tool: "verify",
			label: "Run full verification",
			level: "required",
		}),
	},

	// format (replaces fix)
	{
		forTools: ["format"],
		condition: () => true,
		recommendation: () => ({
			tool: "verify",
			label: "Verify after formatting",
			level: "required",
		}),
	},

	// find_tests
	{
		forTools: ["find_tests"],
		condition: (ctx) => Boolean(ctx.testFunc),
		recommendation: (ctx) => ({
			tool: "impact",
			params: { symbol: ctx.testFunc! },
			label: "Trace test function",
			level: "recommended",
		}),
	},

	// rename_symbol
	{
		forTools: ["rename_symbol"],
		condition: (ctx) => Boolean(ctx.topSymbol),
		recommendation: (ctx) => ({
			tool: "impact",
			params: { symbol: ctx.topSymbol! },
			label: "Verify blast radius before rename",
			level: "required",
		}),
	},

	// safe_delete
	{
		forTools: ["safe_delete"],
		condition: (ctx) => Boolean(ctx.topSymbol),
		recommendation: (ctx) => ({
			tool: "impact",
			params: { symbol: ctx.topSymbol! },
			label: "Verify zero references before delete",
			level: "required",
		}),
	},
];

/**
 * Build a standardized "Next" section with tool recommendations.
 * Only shows "required" level recommendations to reduce noise (fixes #112).
 * "recommended" and "also" levels are suppressed since the AI already
 * knows about available tools from the system prompt.
 */
export function formatNextSection(nextItems: NextRecommendation[]): string {
	// Filter to only show required-level recommendations
	const requiredItems = nextItems.filter((item) => item.level === "required");
	if (requiredItems.length === 0) return "";

	const lines: string[] = ["### Next (Required)", ""];

	for (const item of requiredItems) {
		const cmd = buildToolCommand(item);
		lines.push(`- [REQUIRED] ${item.label}: \`${cmd}\``);
	}

	return lines.join("\n");
}

function buildToolCommand(item: NextRecommendation): string {
	const params = item.params
		? Object.entries(item.params)
				.map(([k, v]) => `--${k} ${v}`)
				.join(" ")
		: "";
	return `shazam_${item.tool} ${params}`.trim();
}

/**
 * Get standardized Next recommendations for a given tool and context.
 * Driven by the declarative NEXT_RULES array. Adding a new tool =
 * adding rules to NEXT_RULES, not editing this function.
 *
 * Pass the RepoGraph when available to enable graph-aware filters
 * (e.g., suppress find_tests when project has no test files). When
 * graph is undefined, filters preserve legacy (always-emit) behavior.
 */
export function getNextForTool(toolName: string, context?: NextContext, graph?: RepoGraph): NextRecommendation[] {
	const ctx: NextContext = context ?? {};
	const out: NextRecommendation[] = [];

	for (const rule of NEXT_RULES) {
		if (!rule.forTools.includes(toolName)) continue;
		if (!rule.condition(ctx, graph)) continue;
		const rec = rule.recommendation(ctx);
		if (rec) out.push(rec);
	}

	return out;
}

// -- Section builders ------------------------------------------------------

/**
 * Build a standardized Result Summary section with key-value pairs.
 */
export function formatResultSummary(title: string, pairs: [string, string | number][]): string {
	const lines: string[] = [`## ${title}`, ""];
	for (const [key, value] of pairs) {
		lines.push(`**${key}:** ${value}`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Build a file-item line for the Detail section.
 */
export function formatFileItem(file: string, line: number, label: string, extra?: string): string {
	const loc = line > 0 ? `:${line}` : "";
	const suffix = extra ? ` - ${extra}` : "";
	return `- ${label} \`${file}${loc}\`${suffix}`;
}

/**
 * Build the full three-section output for any tool.
 * Each section is optional -- pass empty/null to skip.
 */
export function buildToolOutput(
	resultSection: string,
	detailSection: string | null,
	nextSection: string | null,
): string {
	const parts: string[] = [resultSection.trim()];
	if (detailSection) parts.push(detailSection.trim());
	if (nextSection) parts.push(nextSection.trim());
	return parts.join("\n\n") + "\n";
}

// -- Context helpers -------------------------------------------------------

/**
 * Get the number of uncommitted git changes (for context in output).
 * Returns 0 on error instead of -1 to match expected return semantics (fixes #99).
 */
export function getGitChangeCount(): number {
	try {
		const output = execSync("git diff --stat 2>/dev/null | tail -1", { encoding: "utf-8", timeout: 3000 }).trim();
		const match = output.match(/(\d+)\s+file/);
		return match ? parseInt(match[1]!, 10) : 0;
	} catch (err) {
		_logWarn("getGitChangeCount", "git diff --stat failed", err);
		return 0;
	}
}

/**
 * Get overall project stats from the graph.
 */
export function getGraphSummary(graph: RepoGraph): { symbols: number; files: number; edges: number } {
	const edgeCount = getGraphEdgeCount(graph);
	return {
		symbols: graph.symbols.size,
		files: graph.fileSymbols.size,
		edges: edgeCount,
	};
}

// -- Token budget truncation -------------------------------------------------

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count for a text string using ~4 chars/token heuristic.
 * No external dependency -- fast enough for inline use during formatting.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function isHighPriorityLine(line: string): boolean {
	if (line.startsWith("## ")) return true;
	if (line.startsWith("### ")) return true;
	if (line.startsWith("**") && line.includes(":**")) return true;
	return false;
}

/**
 * Truncate an array of output lines to fit within a token budget.
 * Preserves high-priority lines (headers, key-value pairs) and top items.
 * Low-priority lines are replaced with "... and N more (truncated)".
 */
export function truncateOutput(lines: string[], maxTokens: number): string {
	if (lines.length === 0) return "";

	const totalTokens = estimateTokens(lines.join("\n"));
	if (totalTokens <= maxTokens) {
		return lines.join("\n");
	}

	const kept: string[] = [];
	let usedTokens = 0;
	let truncatedCount = 0;
	let truncating = false;

	for (const line of lines) {
		const lineTokens = estimateTokens(line);

		if (isHighPriorityLine(line)) {
			kept.push(line);
			usedTokens += lineTokens;
			continue;
		}

		if (truncating || usedTokens + lineTokens > maxTokens) {
			truncating = true;
			truncatedCount++;
			continue;
		}

		kept.push(line);
		usedTokens += lineTokens;
	}

	if (truncatedCount > 0) {
		kept.push(`... and ${truncatedCount} more (truncated)`);
	}

	return kept.join("\n");
}

/**
 * Log a warning without printing the full error stack trace.
 *
 * For ENOENT (file not found — expected when a configured binary is not
 * installed), suppress log output entirely to avoid noise.
 *
 * For other errors, prints a concise one-line message: "tag: msg - reason".
 * Never passes the raw Error object to console, as Node.js would print the
 * full stack trace, making normal degradation look like a crash.
 *
 * Usage:
 *   _logWarn("isExecutable", "statSync failed for /path/to/binary", err)
 */
export function _logWarn(tag: string, message: string, err: unknown): void {
	if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
		return; // expected: file not found, suppress completely
	}
	const reason = err instanceof Error ? err.message : String(err);
	console.warn(`[pi-shazam] ${tag}: ${message} - ${reason}`);
}

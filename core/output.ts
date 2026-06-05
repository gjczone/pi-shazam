/**
 * pi-shazam core/output — Standardized tool output formatting.
 *
 * All tool outputs follow a three-section skeleton:
 *   1. ## Result Summary (key-value table / quick summary)
 *   2. ### Detail (per-item expansion)
 *   3. ### Next (actionable tool recommendations)
 *
 * This module provides builders for each section.
 */

import type { RepoGraph } from "./graph.js";
import { execSync } from "node:child_process";

// ── Next recommendation system ────────────────────────────────────────────

export type NextLevel = "required" | "recommended" | "also";

export interface NextRecommendation {
	tool: string;
	params?: Record<string, string | number | boolean>;
	label: string;
	level: NextLevel;
}

/**
 * Build a standardized "Next" section with tool recommendations.
 * 🔴 Required / 🟡 Recommended / ⚪ Also
 */
export function formatNextSection(nextItems: NextRecommendation[]): string {
	if (nextItems.length === 0) return "";

	const lines: string[] = ["### Next (Recommended)", ""];

	for (const item of nextItems) {
		const icon =
			item.level === "required"
				? "🔴"
				: item.level === "recommended"
					? "🟡"
					: "⚪";
		const cmd = buildToolCommand(item);
		lines.push(`- ${icon} ${item.label}: \`${cmd}\``);
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
 * Follows the Next 分级系统 table from issue #18.
 * Pass available context (topFile, topSymbol, orphanCount, riskLevel, etc.)
 * to generate context-aware recommendations.
 */
export function getNextForTool(
	toolName: string,
	context?: {
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
	},
): NextRecommendation[] {
	const c = context ?? {};
	const items: NextRecommendation[] = [];

	switch (toolName) {
		case "overview":
			if (c.topFile) items.push({ tool: "file_detail", params: { file: c.topFile }, label: "Inspect top file", level: "recommended" });
			items.push({ tool: "codesearch", params: { query: "<keyword>" }, label: "Search for related symbols", level: "also" });
			break;

		case "hotspots":
			if (c.topFile) items.push({ tool: "file_detail", params: { file: c.topFile }, label: "Inspect top hotspot", level: "recommended" });
			items.push({ tool: "overview", label: "Review project overview", level: "also" });
			break;

		case "symbol":
			if (c.topSymbol) items.push({ tool: "call_chain", params: { symbol: c.topSymbol }, label: "Trace call chain", level: "recommended" });
			if (c.topSymbol) items.push({ tool: "hover", params: { name: c.topSymbol }, label: "Get type info", level: "also" });
			break;

		case "codesearch":
			if (c.topSymbol) items.push({ tool: "symbol", params: { name: c.topSymbol }, label: "View top result details", level: "recommended" });
			items.push({ tool: "find_tests", label: "Find related tests", level: "also" });
			break;

		case "call_chain":
			items.push({ tool: "impact", params: { files: "<caller-file>" }, label: "Assess blast radius", level: "recommended" });
			if (c.topSymbol) items.push({ tool: "hover", params: { name: c.topSymbol }, label: "Inspect symbol type", level: "also" });
			break;

		case "hover":
			if (c.topSymbol) items.push({ tool: "symbol", params: { name: c.topSymbol }, label: "View symbol graph info", level: "recommended" });
			if (c.topSymbol) items.push({ tool: "type_hierarchy", params: { name: c.topSymbol }, label: "Explore type hierarchy", level: "also" });
			break;

		case "file_detail":
			if (c.topSymbol) items.push({ tool: "symbol", params: { name: c.topSymbol }, label: "Inspect top symbol", level: "recommended" });
			if (c.topFile) items.push({ tool: "find_tests", params: { sourceFile: c.topFile }, label: "Find tests for this file", level: "also" });
			break;

		case "find_tests":
			if (c.testFunc) items.push({ tool: "call_chain", params: { symbol: c.testFunc }, label: "Trace test function", level: "recommended" });
			break;

		case "routes":
			if (c.handlerFile) items.push({ tool: "file_detail", params: { file: c.handlerFile }, label: "Inspect handler", level: "recommended" });
			break;

		case "state_map":
			if (c.usageFile) items.push({ tool: "impact", params: { files: c.usageFile }, label: "Assess usage impact", level: "recommended" });
			break;

		case "type_hierarchy":
			items.push({ tool: "find_tests", label: "Find tests for related types", level: "recommended" });
			items.push({ tool: "hover", label: "Get hover info", level: "also" });
			break;

		case "impact":
			items.push({ tool: "verify", label: "Run verification after changes", level: "required" });
			if (c.topSymbol) items.push({ tool: "call_chain", params: { symbol: c.topSymbol }, label: "Trace top impacted symbol", level: "recommended" });
			break;

		case "check":
			if (c.hasErrors) items.push({ tool: "verify", label: "Run full verification", level: "required" });
			if (c.hasFixes) items.push({ tool: "fix", label: "Auto-fix format issues", level: "recommended" });
			if (c.brokenFile) items.push({ tool: "symbol", params: { name: "--file " + c.brokenFile }, label: "Check broken file symbols", level: "also" });
			break;

		case "verify":
			if (c.riskLevel === "high") items.push({ tool: "ready", label: "Run pre-commit readiness check", level: "required" });
			if (c.orphanCount && c.orphanCount > 0) items.push({ tool: "call_chain", params: { symbol: "<orphan>" }, label: "Trace orphan symbols", level: "recommended" });
			break;

		case "fix":
			items.push({ tool: "verify", label: "Verify after fixing", level: "required" });
			items.push({ tool: "check", label: "Re-check for remaining issues", level: "recommended" });
			break;

		case "ready":
			items.push({ tool: "", label: "Commit and push changes", level: "required" });
			break;

		case "rename_symbol":
			if (c.topSymbol) items.push({ tool: "call_chain", params: { symbol: c.topSymbol }, label: "Verify blast radius before rename", level: "required" });
			items.push({ tool: "hover", label: "Inspect symbol type", level: "also" });
			break;

		case "safe_delete":
			if (c.topSymbol) items.push({ tool: "call_chain", params: { symbol: c.topSymbol }, label: "Verify zero references before delete", level: "required" });
			break;

		default:
			break;
	}

	return items;
}

// ── Section builders ──────────────────────────────────────────────────────

/**
 * Build a standardized Result Summary section with key-value pairs.
 */
export function formatResultSummary(
	title: string,
	pairs: [string, string | number][],
): string {
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
export function formatFileItem(
	file: string,
	line: number,
	label: string,
	extra?: string,
): string {
	const loc = line > 0 ? `:${line}` : "";
	const suffix = extra ? ` — ${extra}` : "";
	return `- ${label} \`${file}${loc}\`${suffix}`;
}

/**
 * Build the full three-section output for any tool.
 * Each section is optional — pass empty/null to skip.
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

// ── Context helpers ───────────────────────────────────────────────────────

/**
 * Get the number of uncommitted git changes (for context in output).
 */
export function getGitChangeCount(): number {
	try {
		const output = execSync(
			"git diff --stat 2>/dev/null | tail -1",
			{ encoding: "utf-8", timeout: 3000 },
		).trim();
		const match = output.match(/(\d+)\s+file/);
		return match ? parseInt(match[1]!, 10) : 0;
	} catch {
		return 0;
	}
}

/**
 * Get overall project stats from the graph.
 */
export function getGraphSummary(graph: RepoGraph): { symbols: number; files: number; edges: number } {
	let edgeCount = 0;
	for (const [, edges] of graph.outgoing) {
		edgeCount += edges.length;
	}
	return {
		symbols: graph.symbols.size,
		files: graph.fileSymbols.size,
		edges: edgeCount,
	};
}

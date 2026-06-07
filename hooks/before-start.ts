/**
 * pi-shazam hooks/before-start — Inject project overview into system prompt.
 *
 * Registered on the `before_agent_start` event. Scans the project with
 * tree-sitter, generates an overview, and injects it into the system prompt
 * so the LLM has structural awareness before reading any code.
 *
 * Also injects context-sensitive proactive recommendations based on project
 * state (test files, type hierarchy, git status).
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { executeOverview } from "../tools/overview.js";
import { hasTestFiles, hasHierarchyKinds } from "../core/output.js";
import { createBaseline, clearBaseline, getBaseline, formatBaselineSummary } from "../core/baseline.js";
import { execSync } from "node:child_process";

/**
 * Get the number of uncommitted changes in the working tree.
 */
function getUncommittedChangeCount(projectRoot: string): number {
	try {
		const output = execSync(
			"git diff --name-only --diff-filter=ACMR 2>/dev/null; git diff --cached --name-only --diff-filter=ACMR 2>/dev/null",
			{ cwd: projectRoot, encoding: "utf-8", timeout: 3000 },
		).trim();
		if (!output) return 0;
		return new Set(output.split("\n").filter(Boolean)).size;
	} catch {
		return 0;
	}
}

/**
 * Build proactive recommendations section based on project state.
 * Only includes contextually relevant recommendations to minimize tokens.
 * Accepts an already-scanned graph to avoid redundant re-scanning (fixes #95).
 */
function buildProactiveRecommendations(projectRoot: string, graph: RepoGraph): string {
	const lines: string[] = [];

	try {
		const hasTests = hasTestFiles(graph);
		const hasHierarchy = hasHierarchyKinds(graph);
		const uncommitted = getUncommittedChangeCount(projectRoot);

		lines.push("### Proactive Recommendations");
		lines.push("");

		// Only include recommendations that are contextually relevant
		if (uncommitted > 0) {
			lines.push(`- [REQUIRED] You have ${uncommitted} uncommitted change(s). Run \`shazam_verify --preCommit\` before committing.`);
		}

		// Always include the most critical workflow guidance
		lines.push("- Before editing a file for the first time: \`shazam_file_detail --file <path>\`");
		lines.push("- Before changing a shared/exported symbol: \`shazam_call_chain --symbol <name>\`");

		// Conditional: only mention if project has tests
		if (hasTests) {
			lines.push("- Find related tests: \`shazam_find_tests --sourceFile <file>\`");
		}

		// Conditional: only mention if project has OOP types
		if (hasHierarchy) {
			lines.push("- For OOP type hierarchies: \`shazam_type_hierarchy --name <class>\`");
		}

		// Core workflow tools
		lines.push("- After every edit: \`shazam_verify\` to check for errors");
		lines.push("- Instead of grep: \`shazam_codesearch --query <keyword>\`");
	} catch {
		// If scan fails, provide minimal recommendations
		lines.push("### Recommendations");
		lines.push("");
		lines.push("- \`shazam_overview\` to understand project structure");
		lines.push("- \`shazam_file_detail --file <path>\` before editing any file");
		lines.push("- \`shazam_verify\` after every edit");
	}

	return lines.join("\n");
}

/**
 * Build a session baseline summary section.
 * Accepts an already-scanned graph to avoid redundant re-scanning (fixes #95).
 */
function buildSessionBaselineSection(_projectRoot: string, graph: RepoGraph): string {
	try {
		const branch = execSync("git branch --show-current 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();
		const commit = execSync("git rev-parse HEAD 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();

		// Clear any previous baseline and capture current state
		clearBaseline();
		createBaseline(graph, 0, 0, branch || "unknown", commit || "unknown");

		return formatBaselineSummary(getBaseline()!);
	} catch {
		return "";
	}
}

/**
 * Generate a project overview string suitable for system prompt injection.
 *
 * @param projectRoot - Absolute or relative path to the project root
 * @returns A formatted overview string prefixed with [pi-shazam] tag
 */
export function generateOverviewForPrompt(projectRoot: string): string {
	// Scan once at the top level and pass the graph to all helpers (fixes #95).
	const graph = scanProject(projectRoot, () => {});
	const overview = executeOverview(graph, projectRoot);
	const recommendations = buildProactiveRecommendations(projectRoot, graph);
	const baselineSection = buildSessionBaselineSection(projectRoot, graph);
	const parts = [`[pi-shazam] Project Overview:\n${overview}`, recommendations, baselineSection].filter(Boolean);
	return parts.join("\n\n");
}

/**
 * Register the before-start hook on the Pi extension API.
 *
 * On `before_agent_start`, generates a project overview and injects it
 * into the system prompt array.
 */
export function registerBeforeStartHook(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, _ctx) => {
		try {
			const overviewText = generateOverviewForPrompt(".");
			// Append overview to the system prompt
			return {
				systemPrompt: overviewText,
			};
		} catch (err) {
			pi.logger?.warn(`[pi-shazam] Failed to generate overview: ${err}`);
			// Don't block agent start on overview failure
			return undefined;
		}
	});
}

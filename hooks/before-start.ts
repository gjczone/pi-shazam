/**
 * pi-shazam hooks/before-start — Inject project overview into system prompt.
 *
 * Registered on the `before_agent_start` event. Scans the project with
 * tree-sitter, generates an overview, and injects it into the system prompt
 * so the LLM has structural awareness before reading any code.
 *
 * Also injects context-sensitive proactive recommendations based on project
 * state (test files, type hierarchy, git status).
 *
 * Composable parts (fixes #124):
 * - getUncommittedChangeCount: counts uncommitted changes
 * - buildProactiveRecommendations: builds context-aware recommendations
 * - buildSessionBaselineSection: builds baseline summary
 * - generateOverviewForPrompt: orchestrates all parts
 *
 * NOTE: This handler MUST be registered AFTER the LSP init handler in index.ts.
 * Only this handler returns { systemPrompt }. If ordering changes, the system
 * prompt injection could be silently lost.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { executeOverview } from "../tools/overview.js";
import { hasTestFiles, hasHierarchyKinds } from "../core/output.js";
import { createBaseline, getBaseline, formatBaselineSummary } from "../core/baseline.js";
import { safeGitExec, isProjectDir } from "../core/git-utils.js";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SKIP_DIRS } from "../core/filter.js";
import { EXT_TO_LANG } from "../core/treesitter.js";

/** Source file extensions set (mirrors core/scanner.ts SOURCE_EXTS). */
const SOURCE_EXTS = new Set(Object.keys(EXT_TO_LANG));

/**
 * File count threshold above which we skip the synchronous scanProject
 * for the before-start overview. Prevents blocking agent startup on
 * very large projects (5000+ source files can take 5-10s to scan).
 */
const OVERVIEW_FILE_COUNT_THRESHOLD = 5000;

/**
 * Quickly count source files in a project up to a limit.
 * Uses only readdirSync (no tree-sitter parsing) so it's fast.
 * Returns as soon as count >= limit to avoid unnecessary work.
 */
function countSourceFilesUpTo(root: string, limit: number): number {
	let count = 0;
	const resolvedRoot = resolve(root);

	function walk(dir: string) {
		if (count >= limit) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // permission denied or unreadable directory
		}
		for (const entry of entries) {
			if (count >= limit) return;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				if (entry.name.startsWith(".")) continue;
				walk(join(dir, entry.name));
			} else if (entry.isFile()) {
				const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
				if (SOURCE_EXTS.has(ext)) count++;
			}
		}
	}

	walk(resolvedRoot);
	return count;
}

/**
 * 统计未提交的变更文件数（issue #350：使用 safeGitExec 抑制 stderr）。
 */
function getUncommittedChangeCount(projectRoot: string): number {
	const unstaged = safeGitExec(["diff", "--name-only", "--diff-filter=ACMR"], projectRoot, 3000);
	const staged = safeGitExec(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], projectRoot, 3000);
	const combined = [unstaged, staged].filter(Boolean).join("\n").trim();
	if (!combined) return 0;
	return new Set(combined.split("\n").filter(Boolean)).size;
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
			lines.push(
				`- [REQUIRED] You have ${uncommitted} uncommitted change(s). Run \`shazam_verify --preCommit\` before committing.`,
			);
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
	let branch = "unknown";
	let commit = "unknown";
	const branchOutput = safeGitExec(["branch", "--show-current"], _projectRoot, 3000);
	if (branchOutput) branch = branchOutput;
	const commitOutput = safeGitExec(["rev-parse", "HEAD"], _projectRoot, 3000);
	if (commitOutput) commit = commitOutput;

	try {
		// createBaseline immediately reassigns _baseline and _previousOrphans,
		// so no explicit clearBaseline() is needed here.
		createBaseline(graph, 0, 0, branch, commit);

		const baseline = getBaseline();
		return baseline ? formatBaselineSummary(baseline) : "";
	} catch {
		return "";
	}
}

/**
 * Track whether we've already shown the overview in this session.
 * For continuation sessions, we skip the full overview to save tokens.
 */
let _hasShownOverview = false;

/**
 * Generate a project overview string suitable for system prompt injection.
 *
 * @param projectRoot - Absolute or relative path to the project root
 * @param isContinuation - Whether this is a continuation of an existing session
 * @returns A formatted overview string prefixed with [pi-shazam] tag
 */
export function generateOverviewForPrompt(projectRoot: string, isContinuation = false): string {
	// For continuation sessions, skip the full overview (fixes #117, #118)
	if (isContinuation && _hasShownOverview) {
		return "[pi-shazam] Session continuation — use shazam_overview for project structure.";
	}

	// 非项目目录快速短路（issue #350）：
	// 若目录既不是 git 仓库，也没有任何项目标记文件（package.json 等），
	// 跳过 scanProject，避免在 /tmp 等大型临时目录下同步阻塞。
	if (!isProjectDir(projectRoot)) {
		_hasShownOverview = true;
		return [
			"[pi-shazam] This directory does not appear to be a project (no git repo, no project files).",
			"Run `shazam_overview` manually if you want to scan it.",
		].join("\n");
	}

	// Pre-check: skip synchronous scanProject on very large projects to
	// prevent blocking agent startup for 5-10s (fixes #312).
	const fileCount = countSourceFilesUpTo(projectRoot, OVERVIEW_FILE_COUNT_THRESHOLD + 1);
	if (fileCount > OVERVIEW_FILE_COUNT_THRESHOLD) {
		_hasShownOverview = true;
		return [
			"[pi-shazam] Project is very large (5000+ source files).",
			"Full overview scan skipped to avoid blocking startup.",
			"Run `shazam_overview` manually to get the project structure map.",
		].join("\n");
	}

	// Scan once at the top level and pass the graph to all helpers (fixes #95).
	const graph = scanProject(projectRoot, () => {});
	const overview = executeOverview(graph, projectRoot);
	const recommendations = buildProactiveRecommendations(projectRoot, graph);
	const baselineSection = buildSessionBaselineSection(projectRoot, graph);
	const parts = [`[pi-shazam] Project Overview:\n${overview}`, recommendations, baselineSection].filter(Boolean);

	_hasShownOverview = true;
	return parts.join("\n\n");
}

/**
 * Reset the overview shown flag (for testing).
 */
export function resetOverviewShown(): void {
	_hasShownOverview = false;
}

/**
 * Register the before-start hook on the Pi extension API.
 *
 * On `before_agent_start`, generates a project overview and injects it
 * into the system prompt array. Skips full overview for continuation sessions.
 */
export function registerBeforeStartHook(pi: ExtensionAPI): void {
	// Reset overview flag and reminders on new session
	pi.on("session_start", () => {
		_hasShownOverview = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			// Use ctx.cwd (Pi's detected project root) instead of "." so the
			// overview scans the right directory when pi is started from a
			// parent directory (issue #241).
			const projectRoot = ctx.cwd || ".";
			const overviewText = generateOverviewForPrompt(projectRoot, _hasShownOverview);
			// Append overview to the existing system prompt (AGENTS.md, skills, etc.)
			// NOT replace — returning systemPrompt alone would wipe global rules and skill descriptions
			const existing = event.systemPrompt ?? [];
			const merged = [...existing, overviewText].filter(Boolean);
			return {
				systemPrompt: merged.join("\n\n"),
			};
		} catch (err) {
			console.warn(`[pi-shazam] Failed to generate overview: ${err}`);
			// Don't block agent start on overview failure
			return undefined;
		}
	});
}

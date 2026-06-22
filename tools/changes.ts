/**
 * pi-shazam tools/changes — Git change summary with symbol-level detail.
 *
 * Lightweight view of what changed in the working tree: changed files,
 * affected symbols, risk level, and which callers may be impacted.
 * Complements shazam_verify (which runs full diagnostics); changes
 * focuses on the diff summary without LSP overhead.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { createTool } from "./_factory.js";
import { buildEnvelope } from "./_factory.js";
import { findOrphans } from "../core/filter.js";
import { getGraphEdgeCount } from "../core/graph.js";
import { diffFromBaseline } from "../core/baseline.js";
import { safeGitExec } from "../core/git-utils.js";
import { getNextForTool, formatNextSection } from "../core/output.js";

export function registerChanges(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_changes",
		label: "Change Summary",
		description: `\
		Without this, you optimize the wrong files. Returns a concise summary
		of what changed in the working tree: changed files, affected symbols,
		risk level, and which callers may be impacted. Use after edits to see
		the blast radius before running full verification.`,
		params: Type.Object({}),
		execute(graph, params) {
			const json = params.json ?? false;
			const projectRoot = (params.project as string) || ".";
			return json ? executeChangesJson(graph, projectRoot) : executeChanges(graph, projectRoot);
		},
	});
}

export function executeChanges(graph: RepoGraph, projectRoot: string): string {
	const gitDir = _resolveGitWorkdir(projectRoot);
	const changedFiles = _getGitChangedFiles(gitDir);
	const orphanResult = findOrphans(graph);
	const internalOrphans = orphanResult.internal;
	const baselineDiff = diffFromBaseline(graph, 0, 0);

	const lines: string[] = [];
	lines.push("## Change Summary");
	lines.push("");

	lines.push(
		`**Symbols:** ${graph.symbols.size} | **Files:** ${graph.fileSymbols.size} | **Edges:** ${getGraphEdgeCount(graph)}`,
	);
	lines.push("");

	if (changedFiles.length > 0) {
		lines.push(`### Git Working Tree Changes (${changedFiles.length} files)`);
		for (const f of changedFiles.slice(0, 30)) lines.push(`  - ${f}`);
		if (changedFiles.length > 30) lines.push(`  ... and ${changedFiles.length - 30} more`);
		lines.push("");
	} else {
		lines.push("### Git Working Tree Changes");
		lines.push("No uncommitted changes.");
		lines.push("");
	}

	// Orphan summary
	const orphanCount = internalOrphans.length;
	const newOrphanCount = baselineDiff?.newOrphans?.length ?? orphanCount;
	if (orphanCount > 0) {
		lines.push(`### Orphan Symbols: ${orphanCount} potentially dead`);
		lines.push(`${newOrphanCount} new since baseline.`);
		lines.push("");
		for (const orphan of internalOrphans.slice(0, 10)) {
			lines.push(`- ${orphan.kind} \`${orphan.name}\` — ${orphan.file}:${orphan.line}`);
		}
		if (internalOrphans.length > 10) lines.push(`  ... and ${internalOrphans.length - 10} more`);
		lines.push("");
	}

	// Risk assessment
	const risk = _assessChangeRisk(graph, internalOrphans, changedFiles);
	lines.push("### Risk Level");
	lines.push(`**${risk.level}** — ${risk.reason}`);
	lines.push("");

	const nextItems = getNextForTool("changes", { riskLevel: risk.level });
	if (nextItems.length > 0) {
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

export function executeChangesJson(graph: RepoGraph, projectRoot: string): string {
	const gitDir = _resolveGitWorkdir(projectRoot);
	const changedFiles = _getGitChangedFiles(gitDir);
	const orphanResult = findOrphans(graph);
	const internalOrphans = orphanResult.internal;
	const risk = _assessChangeRisk(graph, internalOrphans, changedFiles);

	return buildEnvelope("shazam_changes", projectRoot, "ok", {
		symbolCount: graph.symbols.size,
		fileCount: graph.fileSymbols.size,
		edgeCount: getGraphEdgeCount(graph),
		gitChangedFiles: changedFiles.slice(0, 50),
		orphanCount: internalOrphans.length,
		riskLevel: risk.level,
		riskReason: risk.reason,
	});
}

// ── Helpers ──────────────────────────────────────────────────────────────

function _resolveGitWorkdir(cwd: string): string {
	const result = safeGitExec(["rev-parse", "--show-toplevel"], cwd, 5000);
	return result || cwd;
}

function _getGitChangedFiles(gitDir: string): string[] {
	const unstaged = safeGitExec(["diff", "--name-only", "--diff-filter=ACMR"], gitDir, 5000);
	const staged = safeGitExec(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], gitDir, 5000);
	const combined = [unstaged, staged].filter(Boolean).join("\n").trim();
	if (!combined) return [];
	return [...new Set(combined.split("\n").filter(Boolean))];
}

function _assessChangeRisk(
	_graph: RepoGraph,
	internalOrphans: { name: string; kind: string; file: string; line: number }[],
	gitChangedFiles: string[],
): { level: string; reason: string } {
	const baselineDiff = diffFromBaseline(_graph, 0, 0);
	const orphanDelta = baselineDiff?.orphanSymbols ?? internalOrphans.length;
	const newOrphanCount = baselineDiff?.newOrphans?.length ?? internalOrphans.length;
	const gitFileCount = gitChangedFiles.length;
	const totalImpact = gitFileCount + orphanDelta;

	if (totalImpact === 0) return { level: "low", reason: "No changes detected, no new orphan symbols." };
	if (newOrphanCount > 10 || totalImpact > 60) {
		return { level: "high", reason: `${newOrphanCount} new orphans, ${gitFileCount} git-modified files.` };
	}
	if (newOrphanCount > 0 || totalImpact > 20) {
		return {
			level: "medium",
			reason: `${newOrphanCount} new orphans, ${gitFileCount} modified files — review recommended.`,
		};
	}
	return { level: "low", reason: `${newOrphanCount} new orphans, ${gitFileCount} modified files — acceptable.` };
}

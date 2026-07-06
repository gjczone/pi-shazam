/**
 * pi-shazam tools/changes -- Git change summary with symbol-level detail.
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
import { dispatchChanges } from "./_dispatchers.js";
import { findOrphans } from "../core/filter.js";
import { getGraphEdgeCount } from "../core/graph.js";
import { diffFromBaseline } from "../core/baseline.js";
import { assessRisk } from "../core/risk.js";
import { getGitChangedFiles } from "../core/git-utils.js";
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
			const projectRoot = (params.project as string) || ".";
			return dispatchChanges(graph, params, projectRoot).text;
		},
	});
}

/**
 * #631 A: typed return value of shazam_changes. The dispatcher
 * (tools/_dispatchers.ts) chooses whether to render as markdown or
 * wrap in a JSON envelope. `kind` discriminator for error / not_found
 * cases; `isCompact` true when the 3-line shortcut fired (#634).
 */
export interface ChangesResult {
	kind: "changes";
	symbolCount: number;
	fileCount: number;
	edgeCount: number;
	gitChangedFiles: string[];
	orphanCount: number;
	newOrphanCount: number;
	risk: { level: string; reason: string };
	isCompact: boolean;
	nextSteps?: string[];
}

/**
 * #631 A: build the typed ChangesResult. Single source of truth for
 * the data; both the markdown renderer and the JSON envelope wrap
 * this object.
 */
export function buildChangesResult(graph: RepoGraph, projectRoot: string): ChangesResult {
	const changedFiles = getGitChangedFiles(projectRoot);
	const orphanResult = findOrphans(graph);
	const internalOrphans = orphanResult.internal;
	const baselineDiff = diffFromBaseline(graph, 0, 0);
	const orphanCount = internalOrphans.length;
	const newOrphanCount = baselineDiff?.newOrphans?.length ?? orphanCount;
	const risk = _assessChangeRisk(graph, internalOrphans, changedFiles);
	const isCompact = changedFiles.length === 0 && orphanCount === 0;

	const nextItems = getNextForTool("changes", { riskLevel: risk.level });
	return {
		kind: "changes",
		symbolCount: graph.symbols.size,
		fileCount: graph.fileSymbols.size,
		edgeCount: getGraphEdgeCount(graph),
		gitChangedFiles: changedFiles.slice(0, 50),
		orphanCount,
		newOrphanCount,
		risk,
		isCompact,
		nextSteps: nextItems.length > 0 ? nextItems.map((n) => `${n.level}: ${n.label} -> ${n.tool}`) : undefined,
	};
}

/**
 * #631 A: render a ChangesResult as the existing markdown format. The
 * shape, ordering, and section headings match the previous
 * `executeChanges` output so existing tests and downstream parsers
 * see no diff.
 */
export function renderChangesMarkdown(result: ChangesResult): string {
	// Issue #634: compact 3-line output when there's nothing to report.
	if (result.isCompact) {
		return `## Change Summary\n\nNo uncommitted changes. Risk: ${result.risk.level}.`;
	}

	const lines: string[] = [];
	lines.push("## Change Summary");
	lines.push("");

	lines.push(`**Symbols:** ${result.symbolCount} | **Files:** ${result.fileCount} | **Edges:** ${result.edgeCount}`);
	lines.push("");

	if (result.gitChangedFiles.length > 0) {
		lines.push(`### Git Working Tree Changes (${result.gitChangedFiles.length} files)`);
		for (const f of result.gitChangedFiles.slice(0, 30)) lines.push(`  - ${f}`);
		if (result.gitChangedFiles.length > 30) lines.push(`  ... and ${result.gitChangedFiles.length - 30} more`);
		lines.push("");
	} else {
		lines.push("### Git Working Tree Changes");
		lines.push("No uncommitted changes.");
		lines.push("");
	}

	if (result.orphanCount > 0) {
		lines.push(`### Orphan Symbols: ${result.orphanCount} potentially dead`);
		lines.push(`${result.newOrphanCount} new since baseline.`);
		lines.push("");
	}

	lines.push("### Risk Level");
	lines.push(`**${result.risk.level}** - ${result.risk.reason}`);
	lines.push("");

	// Next steps: only emit if the result has them, and only the
	// required-level section (matches the existing getNextForTool
	// contract -- formatNextSection filters to "required" only).
	if (result.nextSteps && result.nextSteps.length > 0) {
		// nextSteps is a flattened hint list; we re-derive the
		// "required" section from the original logic by calling
		// getNextForTool again with the same context. The
		// nextSteps field is kept for json consumers.
		const nextItems = getNextForTool("changes", { riskLevel: result.risk.level });
		const nextSection = formatNextSection(nextItems);
		if (nextSection) {
			lines.push("", nextSection);
		}
	}

	return lines.join("\n");
}

/**
 * #631 A: backward-compatible string-returning wrapper. Internal
 * callers (and the existing test suite) keep using the same signature
 * and get the same markdown output as before.
 */
export function executeChanges(graph: RepoGraph, projectRoot: string): string {
	return renderChangesMarkdown(buildChangesResult(graph, projectRoot));
}

export function executeChangesJson(graph: RepoGraph, projectRoot: string): string {
	return buildEnvelope("shazam_changes", projectRoot, "ok", buildChangesResult(graph, projectRoot));
}

/**
 * Adapter: converts changes tool parameters into a unified assessRisk call.
 */
function _assessChangeRisk(
	graph: RepoGraph,
	internalOrphans: { name: string; kind: string; file: string; line: number }[],
	gitChangedFiles: string[],
): { level: string; reason: string } {
	const baselineDiff = diffFromBaseline(graph, 0, 0);
	const orphanDelta = baselineDiff?.orphanSymbols ?? internalOrphans.length;
	const newOrphanCount = baselineDiff?.newOrphans?.length ?? internalOrphans.length;
	return assessRisk({ mode: "changes", gitFileCount: gitChangedFiles.length, newOrphanCount, orphanDelta });
}

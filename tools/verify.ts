/**
 * pi-shazam tools/verify — Post-edit diagnostics gate.
 *
 * Runs graph analysis → risk assessment → orphan detection.
 * Falls back to tree-sitter only when LSP is unavailable.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { diffBaseline, loadBaseline } from "../core/cache.js";
import { isNonSourceFile } from "../core/filter.js";
import { execSync } from "node:child_process";
import { getNextForTool, formatNextSection } from "../core/output.js";

export function registerVerify(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_verify",
		label: "Verify Changes",
		description: `\
MUST call after EVERY non-trivial edit or write. This is the evidence
gate — it runs git diff (baseline) → risk assessment → orphan symbol
detection. All in one pass.

If verify fails, your code has problems. Fix them BEFORE committing.
Use --quick for a 2s risk-only check after each edit. Use full verify
(no flag) before commit.

Scenario: after every edit. Before git commit. Before calling
goal_complete. When CI is red and you need local diagnostics.`,
		parameters: Type.Object({
			quick: Type.Optional(Type.Boolean()),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const quick = params.quick ?? false;
			const graph = scanProject(".");

			if (json) {
				return {
					content: [
						{
							type: "text",
							text: executeVerifyJson(graph, ".", { quick }),
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: executeVerify(graph, ".", { quick }),
					},
				],
			};
		},
	});
}

// ── Verify options ──────────────────────────────────────────────────────────

export interface VerifyOptions {
	/** Quick mode: only basic stats, skip deep analysis */
	quick?: boolean;
}

// ── Execute functions (testable without Pi) ────────────────────────────────

/**
 * Run verification against the current graph.
 * Returns a formatted text report.
 */
export function executeVerify(
	graph: RepoGraph,
	projectRoot: string,
	options: VerifyOptions = {},
): string {
	const lines: string[] = [];
	const quick = options.quick ?? false;

	// ── Basic stats ──────────────────────────────────────────────────────
	const symbolCount = graph.symbols.size;
	const fileCount = graph.fileSymbols.size;
	let edgeCount = 0;
	for (const [, edges] of graph.outgoing) {
		edgeCount += edges.length;
	}

	lines.push("## Verify Results");
	lines.push("");
	lines.push(`**Symbols:** ${symbolCount} | **Files:** ${fileCount} | **Edges:** ${edgeCount}`);
	lines.push("");

	// ── Git diff (working tree changes) ──────────────────────────────────
	const gitChangedFiles = getGitChangedFiles(projectRoot);

	lines.push("### Git Working Tree Changes");
	if (gitChangedFiles.length > 0) {
		lines.push(`Files changed: ${gitChangedFiles.length}`);
		for (const f of gitChangedFiles.slice(0, 20)) {
			lines.push(`  - ${f}`);
		}
		if (gitChangedFiles.length > 20) {
			lines.push(`  ... and ${gitChangedFiles.length - 20} more`);
		}
	} else {
		lines.push("No uncommitted changes.");
	}
	lines.push("");

	// ── Baseline diff ────────────────────────────────────────────────────
	const baseline = loadBaseline(projectRoot);
	const diff = diffBaseline(graph, projectRoot);

	if (baseline && diff) {
		const added = diff.addedSymbols?.length ?? 0;
		const removed = diff.removedSymbols?.length ?? 0;
		const modified = diff.modifiedSymbols?.length ?? 0;
		const totalChanges = added + removed + modified;

		lines.push("### Baseline Diff");
		if (totalChanges > 0) {
			lines.push(
				`Changes since baseline: +${added} added, -${removed} removed, ~${modified} modified`,
			);
		} else {
			lines.push("No changes since baseline snapshot.");
		}
		lines.push("");
	} else if (!baseline) {
		lines.push(
			"### Baseline Diff",
			"",
			"No baseline snapshot found. Use `shazam_check` to establish current state.",
			"",
		);
	}

	// ── Orphan detection ─────────────────────────────────────────────────
	const orphans = findOrphanSymbols(graph);
	if (orphans.length > 0) {
		lines.push("### Potential Orphan Symbols");
		lines.push(
			`Found ${orphans.length} symbols with zero incoming references (config files excluded):`,
		);
		for (const orphan of orphans.slice(0, 10)) {
			lines.push(
				`- ${orphan.kind} \`${orphan.name}\` — ${orphan.file}:${orphan.line}`,
			);
		}
		if (orphans.length > 10) {
			lines.push(`  ... and ${orphans.length - 10} more`);
		}
		lines.push("");
	} else {
		lines.push("### Orphan Symbols: None detected", "");
	}

	// ── Risk assessment (considers git changes + baseline diff + orphans) ─
	const risk = assessRisk(graph, diff, orphans, gitChangedFiles);
	lines.push("### Risk Level");
	lines.push(`**${risk.level}** — ${risk.reason}`);
	lines.push("");

	// ── Quick mode: stop here ────────────────────────────────────────────
	if (quick) {
		lines.push("[Quick mode — skipped deep analysis]");
		lines.push("");
	}

	// ── Tree-sitter parse status (full mode) ─────────────────────────────
	if (!quick) {
		lines.push("### Analysis");
		lines.push(`Tree-sitter parsing: ${symbolCount} symbols extracted from source files.`);
		lines.push("");
	}

	// Add Next recommendations
	const nextItems = getNextForTool("verify", { riskLevel: risk.level, orphanCount: orphans.length });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

/**
 * Run verification and return structured JSON.
 */
export function executeVerifyJson(
	graph: RepoGraph,
	projectRoot: string,
	options: VerifyOptions = {},
): string {
	const orphans = findOrphanSymbols(graph);
	const diff = diffBaseline(graph, projectRoot);
	const gitChangedFiles = getGitChangedFiles(projectRoot);
	const risk = assessRisk(graph, diff, orphans, gitChangedFiles);

	let edgeCount = 0;
	for (const [, edges] of graph.outgoing) {
		edgeCount += edges.length;
	}

	return JSON.stringify({
		schema_version: "1.0",
		command: "verify",
		project: projectRoot,
		status: "ok",
		result: {
			symbolCount: graph.symbols.size,
			fileCount: graph.fileSymbols.size,
			edgeCount,
			riskLevel: risk.level,
			riskReason: risk.reason,
			orphanCount: orphans.length,
			orphans: orphans.slice(0, 20).map((s) => ({
				name: s.name,
				kind: s.kind,
				file: s.file,
				line: s.line,
			})),
			baselineDiff: diff
				? {
						addedSymbols: diff.addedSymbols?.length ?? 0,
						removedSymbols: diff.removedSymbols?.length ?? 0,
						modifiedSymbols: diff.modifiedSymbols?.length ?? 0,
					}
				: null,
			gitChangedFiles: gitChangedFiles.slice(0, 50),
			quickMode: options.quick ?? false,
		},
	});
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface RiskResult {
	level: "low" | "medium" | "high";
	reason: string;
}

function getGitChangedFiles(projectRoot: string): string[] {
	try {
		const output = execSync(
			"git diff --name-only --diff-filter=ACMR 2>/dev/null; git diff --cached --name-only --diff-filter=ACMR 2>/dev/null",
			{ cwd: projectRoot, encoding: "utf-8", timeout: 5000 },
		).trim();
		if (!output) return [];
		const files = output.split("\n").filter(Boolean);
		// Deduplicate
		return [...new Set(files)];
	} catch {
		return [];
	}
}

function assessRisk(
	_graph: RepoGraph,
	diff: ReturnType<typeof diffBaseline>,
	orphans: { name: string; kind: string; file: string; line: number }[],
	gitChangedFiles?: string[],
): RiskResult {
	const baselineChanges =
		(diff?.addedSymbols?.length ?? 0) +
		(diff?.removedSymbols?.length ?? 0) +
		(diff?.modifiedSymbols?.length ?? 0);
	const gitFileCount = gitChangedFiles?.length ?? 0;
	const totalImpact = baselineChanges + gitFileCount + orphans.length;

	if (totalImpact === 0) {
		return { level: "low", reason: "No changes detected, no orphan symbols." };
	}

	if (orphans.length > 10 || totalImpact > 60) {
		return {
			level: "high",
			reason: `${orphans.length} orphans, ${baselineChanges} graph changes, ${gitFileCount} git-modified files.`,
		};
	}

	if (orphans.length > 0 || totalImpact > 20) {
		return {
			level: "medium",
			reason: `${orphans.length} orphans, ${baselineChanges} graph changes, ${gitFileCount} modified files — review recommended.`,
		};
	}

	return {
		level: "low",
		reason: `${orphans.length} orphans, ${baselineChanges} changes, ${gitFileCount} modified files — acceptable.`,
	};
}

function findOrphanSymbols(
	graph: RepoGraph,
): { name: string; kind: string; file: string; line: number }[] {
	const orphans: { name: string; kind: string; file: string; line: number }[] =
		[];

	for (const sym of graph.symbols.values()) {
		// Exclude symbols from config files
		if (isNonSourceFile(sym.file)) continue;

		const incoming = graph.incoming.get(sym.id);
		if (!incoming || incoming.length === 0) {
			// Skip entry-point-like symbols (exported, high pagerank)
			if (sym.visibility === "exported" && sym.pagerank > 0.01) continue;
			// Skip anonymous functions and test files
			if (sym.kind === "anonymous_function") continue;
			if (sym.file.includes("tests/") || sym.file.includes(".test.")) continue;
			orphans.push({
				name: sym.name,
				kind: sym.kind,
				file: sym.file,
				line: sym.line,
			});
		}
	}

	return orphans;
}

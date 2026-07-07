/**
 * tools/verify-comment.ts
 *
 * Pure formatter for shazam_verify JSON output → PR comment markdown.
 *
 * #638: GitHub Action wrapper for shazam_verify — PR-time risk-scored review.
 *
 * This module is unit-testable (no file I/O, no network, no side effects).
 * The GitHub Action's `post-comment.mjs` imports this function and
 * posts the result via `gh pr comment`.
 */

/** A single LSP diagnostic entry from the verify JSON output. */
export interface LspDiagEntry {
	file: string;
	line: number;
	col: number;
	severity: "error" | "warning" | "info" | "hint";
	code: string;
	message: string;
	source?: string;
}

/** The verify result object (subset of the full JSON envelope). */
export interface VerifyResult {
	symbolCount: number;
	fileCount: number;
	edgeCount: number;
	riskLevel: string;
	riskReason: string;
	orphanCount: number;
	internalOrphanCount: number;
	exportedOrphanCount: number;
	gitChangedFiles: string[];
	baselineDiff: unknown;
	lspDiagnostics: LspDiagEntry[];
	lspAvailable: boolean;
	verdict: string;
	quickMode: boolean;
	lspOnlyMode: boolean;
	preCommitMode: boolean;
}

/** A critical path entry derived from PageRank (incoming caller count). */
export interface CriticalPath {
	symbol: string;
	incomingCallers: number;
}

/** The full JSON envelope produced by `dispatchVerify({ json: true })`. */
export interface VerifyCommentInput {
	schema_version: string;
	command: string;
	project: string;
	status: string;
	result: VerifyResult;
	/** Optional: critical paths derived from PageRank. */
	criticalPaths?: CriticalPath[];
}

/** Options for formatting the comment. */
export interface FormatOptions {
	/** Maximum number of top errors to display. Default: 3. */
	maxErrors?: number;
}

/**
 * Format a shazam_verify JSON result as a PR comment in markdown.
 *
 * The output matches the comment template in issue #638:
 *
 * ```
 * ## shazam_verify — pi-shazam
 *
 * **Verdict**: FAIL
 * **Risk**: high
 * **Errors**: 2 | **Warnings**: 0 | **Info**: 5
 * **Edges**: 1209 | **Symbols**: 2899 | **Files**: 122
 *
 * ### Top 3 Errors
 * - [ERROR] src/foo.ts:42:5 - Property 'x' is missing...
 *
 * ### Affected Critical Paths
 * - `scanProject` (top by PageRank) — 24 incoming callers
 *
 * ---
 * Full report: artifact `shazam-verify-report` attached to this run.
 * ```
 */
export function formatVerifyComment(input: VerifyCommentInput, opts: FormatOptions = {}): string {
	const { result } = input;
	const maxErrors = opts.maxErrors ?? 3;

	const lines: string[] = [];

	// Mode label
	const modeLabel = result.preCommitMode
		? " (Pre-Commit)"
		: result.quickMode
			? " (Quick)"
			: result.lspOnlyMode
				? " (LSP Only)"
				: "";

	// Header
	lines.push(`## shazam_verify — pi-shazam${modeLabel}`);
	lines.push("");

	// Verdict + Risk
	lines.push(`**Verdict**: ${result.verdict}`);
	lines.push(`**Risk**: ${result.riskLevel}`);

	// Count diagnostics by severity
	let errorCount = 0;
	let warningCount = 0;
	let infoCount = 0;
	for (const d of result.lspDiagnostics) {
		if (d.severity === "error") errorCount++;
		else if (d.severity === "warning") warningCount++;
		else if (d.severity === "info") infoCount++;
	}

	lines.push(`**Errors**: ${errorCount} | **Warnings**: ${warningCount} | **Info**: ${infoCount}`);
	lines.push(`**Edges**: ${result.edgeCount} | **Symbols**: ${result.symbolCount} | **Files**: ${result.fileCount}`);
	lines.push("");

	// Top N Errors
	const errors = result.lspDiagnostics.filter((d) => d.severity === "error");
	if (errors.length > 0) {
		const capped = errors.slice(0, maxErrors);
		lines.push(`### Top ${capped.length} Errors`);
		for (const e of capped) {
			lines.push(`- [ERROR] ${e.file}:${e.line}:${e.col} - ${e.message}`);
		}
		lines.push("");
	}

	// Changed Files
	if (result.gitChangedFiles.length > 0) {
		lines.push("### Changed Files");
		for (const f of result.gitChangedFiles) {
			lines.push(`- \`${f}\``);
		}
		lines.push("");
	}

	// Affected Critical Paths
	if (input.criticalPaths && input.criticalPaths.length > 0) {
		lines.push("### Affected Critical Paths");
		for (const cp of input.criticalPaths) {
			if (cp.incomingCallers === 0) {
				lines.push(`- \`${cp.symbol}\` (verify) — internal-only`);
			} else if (cp.incomingCallers >= 10) {
				lines.push(`- \`${cp.symbol}\` (top by PageRank) — ${cp.incomingCallers} incoming callers`);
			} else {
				lines.push(`- \`${cp.symbol}\` (mcp) — ${cp.incomingCallers} incoming callers`);
			}
		}
		lines.push("");
	}

	// Orphan Summary
	if (result.orphanCount > 0) {
		lines.push("### Orphan Summary");
		lines.push(`**Internal**: ${result.internalOrphanCount} | **Exported**: ${result.exportedOrphanCount}`);
		lines.push("");
	}

	// Footer
	lines.push("---");
	lines.push("Full report: artifact `shazam-verify-report` attached to this run.");

	return lines.join("\n");
}

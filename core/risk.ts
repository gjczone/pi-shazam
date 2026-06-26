/**
 * pi-shazam core/risk -- Unified risk assessment function.
 *
 * Provides a single `assessRisk` function shared by verify, changes, and impact tools,
 * avoiding duplicated risk threshold logic across multiple locations (issue #371).
 *
 * Threshold reference:
 * - preCommit mode: high >= 30, medium >= 10 (stricter pre-commit gate)
 * - Normal mode:    high >= 60, medium >= 20
 * - Impact mode:    high: >10 files or >30 symbols, medium: >3 files or >10 symbols
 *
 * Routing: callers must pass an explicit `mode` so the threshold family is
 * selected by intent, not inferred from `orphanDelta === 0`. The previous
 * inference misrouted verify/changes calls that legitimately had zero
 * orphan delta to impact thresholds (#468).
 */

/** Which tool is calling assessRisk. Selects the threshold family. */
export type AssessRiskMode = "impact" | "verify" | "changes";

export interface RiskResult {
	level: "low" | "medium" | "high";
	reason: string;
}

export interface AssessRiskParams {
	/**
	 * Which tool is requesting the assessment. Required so the threshold
	 * family is chosen by intent rather than inferred from orphanDelta.
	 * Impact uses file/symbol thresholds; verify/changes use totalImpact.
	 */
	mode: AssessRiskMode;
	/** Number of changed files (git changed files for verify/changes, affected files for impact) */
	gitFileCount: number;
	/** Number of new orphan symbols (affected symbol count in impact mode) */
	newOrphanCount: number;
	/** Orphan symbol delta */
	orphanDelta: number;
	/** Number of LSP errors (optional, verify only) */
	lspErrors?: number;
	/** Number of LSP warnings (optional, verify only) */
	lspWarnings?: number;
	/** Whether this is a pre-commit gate */
	preCommit?: boolean;
}

/**
 * Unified risk assessment.
 *
 * Routes by explicit `mode`: impact mode uses file-count and symbol-count
 * thresholds; verify/changes modes use totalImpact = gitFileCount + orphanDelta
 * with optional preCommit-stricter thresholds. The threshold numbers are
 * unchanged; only the routing condition changed (#468).
 */
export function assessRisk(params: AssessRiskParams): RiskResult {
	const { mode, gitFileCount, newOrphanCount, orphanDelta, preCommit } = params;

	if (gitFileCount === 0 && newOrphanCount === 0 && orphanDelta === 0) {
		return { level: "low", reason: "No changes detected." };
	}

	// Impact mode: thresholds based on file count and symbol count separately.
	// Impact does not compute orphanDelta, but the routing decision is now
	// driven by `mode` rather than `orphanDelta === 0` so a verify/changes
	// call with zero orphan delta is no longer misrouted here (#468).
	if (mode === "impact") {
		if (gitFileCount > 10 || newOrphanCount > 30) {
			return {
				level: "high",
				reason: `${gitFileCount} files, ${newOrphanCount} symbols affected - extensive blast radius.`,
			};
		}
		if (gitFileCount > 3 || newOrphanCount > 10) {
			return {
				level: "medium",
				reason: `${gitFileCount} files, ${newOrphanCount} symbols affected - moderate blast radius.`,
			};
		}
		return {
			level: "low",
			reason: `${gitFileCount} files, ${newOrphanCount} symbols affected - contained blast radius.`,
		};
	}

	// verify/changes-style thresholds: based on totalImpact
	const totalImpact = gitFileCount + orphanDelta;
	const highThreshold = preCommit ? 30 : 60;
	const mediumThreshold = preCommit ? 10 : 20;

	if (newOrphanCount > 10 || totalImpact > highThreshold) {
		return {
			level: "high",
			reason: `${newOrphanCount} new orphans, ${gitFileCount} git-modified files.`,
		};
	}
	if (newOrphanCount > 0 || totalImpact > mediumThreshold) {
		return {
			level: "medium",
			reason: `${newOrphanCount} new orphans, ${gitFileCount} modified files - review recommended.`,
		};
	}
	return {
		level: "low",
		reason: `${newOrphanCount} new orphans, ${gitFileCount} modified files - acceptable.`,
	};
}

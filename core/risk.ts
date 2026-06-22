/**
 * pi-shazam core/risk — 统一风险评估函数。
 *
 * 提供单一 `assessRisk` 函数，被 verify、changes、impact 三个工具共用，
 * 避免风险阈值逻辑在多处重复定义（issue #371）。
 *
 * 阈值说明：
 * - preCommit 模式：high >= 30, medium >= 10（更严格的预提交门禁）
 * - 正常模式：      high >= 60, medium >= 20
 * - impact 模式：   high: >10 文件 或 >30 符号，medium: >3 文件 或 >10 符号
 */

export interface RiskResult {
	level: "low" | "medium" | "high";
	reason: string;
}

export interface AssessRiskParams {
	/** 变更的文件数（verify/changes 为 git 变更文件数，impact 为受影响文件数） */
	gitFileCount: number;
	/** 新增孤立符号数（impact 模式下为受影响符号数） */
	newOrphanCount: number;
	/** 孤立符号增量 */
	orphanDelta: number;
	/** LSP 错误数（可选，verify 专用） */
	lspErrors?: number;
	/** LSP 警告数（可选，verify 专用） */
	lspWarnings?: number;
	/** 是否为预提交门禁 */
	preCommit?: boolean;
}

/**
 * 统一风险评估。
 *
 * 当 `orphanDelta === 0` 且 `gitFileCount` 在 impact 典型范围内时，
 * 使用 impact 风格阈值（基于文件数和符号数分别判断）。
 * 否则使用 verify/changes 风格阈值（基于 totalImpact = gitFileCount + orphanDelta）。
 */
export function assessRisk(params: AssessRiskParams): RiskResult {
	const { gitFileCount, newOrphanCount, orphanDelta, preCommit } = params;

	if (gitFileCount === 0 && newOrphanCount === 0 && orphanDelta === 0) {
		return { level: "low", reason: "No changes detected." };
	}

	// impact 模式：orphanDelta 为 0 且数据量在 impact 典型范围内
	// （impact 不计算 orphanDelta，始终传 0）
	if (orphanDelta === 0) {
		// impact 风格阈值：基于文件数和符号数分别判断
		if (gitFileCount > 10 || newOrphanCount > 30) {
			return {
				level: "high",
				reason: `${gitFileCount} files, ${newOrphanCount} symbols affected — extensive blast radius.`,
			};
		}
		if (gitFileCount > 3 || newOrphanCount > 10) {
			return {
				level: "medium",
				reason: `${gitFileCount} files, ${newOrphanCount} symbols affected — moderate blast radius.`,
			};
		}
		return {
			level: "low",
			reason: `${gitFileCount} files, ${newOrphanCount} symbols affected — contained blast radius.`,
		};
	}

	// verify/changes 风格阈值：基于 totalImpact
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
			reason: `${newOrphanCount} new orphans, ${gitFileCount} modified files — review recommended.`,
		};
	}
	return {
		level: "low",
		reason: `${newOrphanCount} new orphans, ${gitFileCount} modified files — acceptable.`,
	};
}

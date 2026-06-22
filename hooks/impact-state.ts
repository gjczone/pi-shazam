/**
 * pi-shazam hooks/impact-state — Shared impact tracking state.
 *
 * Single source of truth for "was a GitHub issue created but shazam_impact
 * not yet run?" Used by issue-guard.ts (sets/clears) and pre-edit.ts (checks).
 *
 * State machine:
 *   idle → pending (setPendingImpact) → idle (clearPendingImpact or resetImpactState)
 */

let _pendingImpact = false;
/** 设置 pending 时的 Unix 毫秒时间戳，用于 TTL 自动清除。 */
let _pendingImpactSetAt: number | null = null;

/** 30 分钟 TTL，超时自动清除 pending 状态（issue #368）。 */
const PENDING_IMPACT_TTL_MS = 30 * 60 * 1000;

/**
 * Mark that a GitHub issue was created and impact analysis is needed
 * before any file edits should proceed.
 */
export function setPendingImpact(): void {
	_pendingImpact = true;
	_pendingImpactSetAt = Date.now();
}

/**
 * Clear the pending impact flag. Called when shazam_impact completes
 * successfully.
 */
export function clearPendingImpact(): void {
	_pendingImpact = false;
	_pendingImpactSetAt = null;
}

/**
 * Check whether a pending impact analysis exists (issue created,
 * shazam_impact not yet run).
 */
export function hasPendingImpact(): boolean {
	if (_pendingImpact && _pendingImpactSetAt !== null && Date.now() - _pendingImpactSetAt > PENDING_IMPACT_TTL_MS) {
		// TTL 过期，自动清除 pending 状态，防止永久阻塞编辑（issue #368）。
		_pendingImpact = false;
		_pendingImpactSetAt = null;
	}
	return _pendingImpact;
}

/**
 * Reset all state. Called on session_start/session_shutdown and in tests.
 */
export function resetImpactState(): void {
	_pendingImpact = false;
	_pendingImpactSetAt = null;
}

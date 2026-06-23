/**
 * pi-shazam hooks/impact-state -- Shared impact tracking state.
 *
 * Single source of truth for "was a GitHub issue created but shazam_impact
 * not yet run?" Used by issue-guard.ts (sets/clears) and pre-edit.ts (checks).
 *
 * State machine:
 *   idle -> pending (setPendingImpact) -> idle (clearPendingImpact or resetImpactState)
 */

let _pendingImpact = false;
/** Unix millisecond timestamp when pending was set, used for TTL auto-clear. */
let _pendingImpactSetAt: number | null = null;

/** 30-minute TTL; pending state auto-clears after timeout (issue #368). */
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
		// TTL expired; auto-clear pending state to prevent permanently blocking edits (issue #368).
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

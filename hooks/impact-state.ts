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

/**
 * Mark that a GitHub issue was created and impact analysis is needed
 * before any file edits should proceed.
 */
export function setPendingImpact(): void {
	_pendingImpact = true;
}

/**
 * Clear the pending impact flag. Called when shazam_impact completes
 * successfully.
 */
export function clearPendingImpact(): void {
	_pendingImpact = false;
}

/**
 * Check whether a pending impact analysis exists (issue created,
 * shazam_impact not yet run).
 */
export function hasPendingImpact(): boolean {
	return _pendingImpact;
}

/**
 * Reset all state. Called on session_start/session_shutdown and in tests.
 */
export function resetImpactState(): void {
	_pendingImpact = false;
}

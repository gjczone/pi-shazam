/**
 * pi-shazam hooks/verify-state — Shared verify tracking state.
 *
 * Single source of truth for "was shazam_verify called recently?"
 * Used by both safety.ts (pre-commit gate) and stop-verify.ts (turn-end reminder).
 *
 * State machine:
 *   idle → verified (markVerifyCalled) → idle (onNewEdit or timeout)
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;

let _verifyCalled = false;
let _lastVerifyTimestamp = 0;

/**
 * Record that shazam_verify completed successfully.
 */
export function markVerifyCalled(): void {
	_verifyCalled = true;
	_lastVerifyTimestamp = Date.now();
}

/**
 * Check if shazam_verify was called within the last 5 minutes
 * and no new edits have occurred since.
 */
export function hasRecentVerify(): boolean {
	if (!_verifyCalled) return false;
	return _lastVerifyTimestamp > Date.now() - FIVE_MINUTES_MS;
}

/**
 * Signal that a new write/edit occurred after the last verify.
 * Resets the verify flag so reminders re-trigger for unverified edits.
 */
export function onNewEdit(): void {
	_verifyCalled = false;
}

/**
 * Reset all state. Called on session_start/session_shutdown and in tests.
 */
export function resetVerifyState(): void {
	_verifyCalled = false;
	_lastVerifyTimestamp = 0;
}

/**
 * pi-shazam hooks/verify-state — Shared verify tracking state.
 *
 * Single source of truth for "was shazam_verify called recently?"
 * Used by both safety.ts (pre-commit gate) and stop-verify.ts (turn-end reminder).
 *
 * State machine:
 *   idle -> verified (markVerifyCalled) -> idle (onNewEdit or timeout)
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;

let _verifyCalled = false;
let _lastVerifyTimestamp = 0;
let _lastVerifyPassed = false;

/**
 * Record that shazam_verify completed, with optional content for verdict parsing.
 * The content parameter is the concatenated text from the tool result's content blocks.
 *
 * Parses the structured envelope (verdict/riskLevel/errors).
 * When content is undefined or unparseable, defaults to fail-closed (not PASS).
 */
export function markVerifyCalled(content?: string): void {
	_verifyCalled = true;
	_lastVerifyTimestamp = Date.now();

	if (content) {
		// Try parsing structured JSON envelope first
		try {
			const parsed = JSON.parse(content);
			const result = parsed?.result;
			const verdict = result?.verdict ?? parsed?.verdict;
			const errors = result?.errors ?? parsed?.errors;
			const riskLevel = result?.riskLevel ?? parsed?.riskLevel;

			if (verdict === "PASS") {
				_lastVerifyPassed = true;
				return;
			}
			if (verdict === "FAIL") {
				_lastVerifyPassed = false;
				return;
			}
			// No verdict field: check errors
			if (Array.isArray(errors) && errors.length > 0) {
				_lastVerifyPassed = false;
				return;
			}
			if (riskLevel === "high") {
				_lastVerifyPassed = false;
				return;
			}
			// Structured envelope but no clear verdict: fail-closed
			_lastVerifyPassed = false;
			return;
		} catch (err) {
			// Not JSON: use text-based parsing
			console.warn("[pi-shazam] markVerifyCalled: JSON.parse failed for verify content", err);
		}

		const isFail =
			/\[FAIL\]\s+NOT\s+READY/i.test(content) ||
			/risk\s*[:=]\s*['"]?\*\*high\*\*/i.test(content) ||
			/Errors:\s*([1-9]\d*)/.test(content);
		_lastVerifyPassed = !isFail;
	} else {
		// No content to parse — fail-closed: assume not passed
		_lastVerifyPassed = false;
	}
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
 * Check if the most recent verify within the last 5 minutes passed
 * (verdict was not FAIL). Returns false if verify was not run or failed.
 */
export function hasRecentPassingVerify(): boolean {
	if (!_verifyCalled) return false;
	if (!_lastVerifyPassed) return false;
	return _lastVerifyTimestamp > Date.now() - FIVE_MINUTES_MS;
}

/**
 * Signal that a new write/edit occurred after the last verify.
 * Resets the verify flag so reminders re-trigger for unverified edits.
 */
export function onNewEdit(): void {
	_verifyCalled = false;
	_lastVerifyPassed = false;
}

/**
 * Reset all state. Called on session_start/session_shutdown and in tests.
 */
export function resetVerifyState(): void {
	_verifyCalled = false;
	_lastVerifyTimestamp = 0;
	_lastVerifyPassed = false;
}

/**
 * pi-shazam tools/rename-state -- Shared rename safety gate state.
 *
 * Tracks which symbols have been reviewed via shazam_impact --symbol.
 * shazam_rename_symbol checks this state before allowing a non-dry-run rename.
 *
 * State machine:
 *   (empty) --[recordCallChain]--> symbol marked as reviewed
 *   symbol marked --[clearRenameState]--> (empty)
 *
 * State is session-scoped: cleared on session_start via index.ts.
 * Never persisted across sessions.
 */

const _reviewedSymbols = new Set<string>();

/**
 * Record that shazam_impact --symbol completed for the given symbol name.
 * Called from tools/impact.ts after successful execution.
 */
export function recordCallChain(symbolName: string): void {
	_reviewedSymbols.add(symbolName);
}

/**
 * Check whether shazam_impact --symbol has been run for the given symbol name
 * in the current session. Used by tools/rename_symbol.ts to gate non-dry-run renames.
 */
export function hasCallChainChecked(symbolName: string): boolean {
	return _reviewedSymbols.has(symbolName);
}

/**
 * Reset all rename state. Called on session_start and in tests.
 */
export function clearRenameState(): void {
	_reviewedSymbols.clear();
}

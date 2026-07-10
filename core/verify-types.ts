/**
 * pi-shazam core/verify-types -- Shared verify option contract.
 *
 * Defined in core/ (not tools/) so hooks can reference it without importing
 * the tools/ layer, preserving the one-way dependency rule. tools/verify.ts
 * re-exports it for existing callers.
 */
export interface VerifyOptions {
	quick?: boolean;
	lspOnly?: boolean;
	preCommit?: boolean;
	/**
	 * Max files to pass to the LSP server for diagnostics. Resolved by
	 * the dispatcher from the per-call value (none) > the
	 * `.pi-shazam/config.json` `verify.maxFiles` value > the hard-coded
	 * default of 100 (#630). Direct callers of `executeVerifyTextAsync`
	 * / `executeVerifyJsonAsync` can still pass an explicit value here.
	 */
	maxFiles?: number;
	// noCascade and noSecrets were never read anywhere in the codebase
	// (dead options from an earlier migration). Dropped in #630 along
	// with the per-call flag. If cascade analysis or secrets detection
	// are reintroduced they should re-appear in `.pi-shazam/config.json`
	// as boolean fields, not as per-call flags.
}

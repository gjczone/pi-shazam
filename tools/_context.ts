/**
 * pi-shazam tools/_context — Tool-level shared context for LspManager.
 *
 * Holds the LspManager reference at the tools/ layer (not core/),
 * preserving the dependency direction: tools/ -> lsp/ (correct),
 * not core/ -> lsp/ (wrong).
 *
 * Set during extension init in index.ts, read by LSP-using tools.
 */
import type { LspManager } from "../lsp/manager.js";

let _manager: LspManager | null = null;

export function setLspManager(mgr: LspManager): void {
	// Shut down previous manager before overwriting to prevent resource leaks.
	// Fire-and-forget: shutdown is async but we don't block the caller.
	const prev = _manager;
	if (prev) {
		prev.shutdown().catch(() => {});
	}
	_manager = mgr;
}

export function getLspManager(): LspManager | null {
	return _manager;
}

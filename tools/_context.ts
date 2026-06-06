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
	_manager = mgr;
}

export function getLspManager(): LspManager | null {
	return _manager;
}

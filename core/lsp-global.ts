/**
 * pi-shazam core/lsp-global — Global LspManager reference for tool access.
 *
 * Tools (e.g., shazam_check) need access to the active LspManager to
 * collect real-time LSP diagnostics. This module provides a global
 * reference set during extension initialization.
 */
import { LspManager } from "../lsp/manager.js";

let _manager: LspManager | null = null;

/**
 * Set the active LspManager (called from index.ts during init).
 */
export function setLspManager(mgr: LspManager): void {
	_manager = mgr;
}

/**
 * Get the active LspManager, or null if not initialized.
 */
export function getLspManager(): LspManager | null {
	return _manager;
}

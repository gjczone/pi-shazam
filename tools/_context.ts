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
let _shutdownPromise: Promise<void> | null = null;

export function setLspManager(mgr: LspManager): void {
	// Wait for previous manager shutdown to complete before overwriting.
	// Store the shutdown promise so getLspManager callers can await it if needed.
	const prev = _manager;
	if (prev) {
		_shutdownPromise = prev.shutdown().catch((err) => {
			console.warn(`[pi-shazam] Previous LspManager shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	}
	_manager = mgr;
}

export function getLspManager(): LspManager | null {
	return _manager;
}

/**
 * Await the previous LspManager shutdown if one is in progress.
 * Call this before initializing new LSP servers.
 */
export async function awaitPreviousShutdown(): Promise<void> {
	if (_shutdownPromise) {
		await _shutdownPromise;
		_shutdownPromise = null;
	}
}

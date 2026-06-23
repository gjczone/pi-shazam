/**
 * pi-shazam tools/_context -- Tool-level shared context for LspManager.
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

/**
 * Set the LspManager reference, awaiting the previous manager's shutdown
 * before swapping. This prevents the race where two LspManagers run
 * concurrently (issue #397).
 */
export async function setLspManager(mgr: LspManager): Promise<void> {
	// Wait for previous manager shutdown to complete before overwriting
	const prev = _manager;
	if (prev) {
		try {
			await prev.shutdown();
		} catch (err) {
			console.warn(
				`[pi-shazam] Previous LspManager shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
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

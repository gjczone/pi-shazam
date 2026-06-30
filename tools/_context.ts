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
import { _logWarn } from "../core/output.js";

let _manager: LspManager | null = null;
let _shutdownPromise: Promise<void> | null = null;

/**
 * Set the LspManager reference, awaiting the previous manager's shutdown
 * before swapping. This prevents the race where two LspManagers run
 * concurrently (issue #397).
 *
 * The in-flight previous shutdown is also published via `_shutdownPromise`
 * so concurrent callers can observe it through `awaitPreviousShutdown()`
 * (issue #546). Without that publication, `before_agent_start` in index.ts
 * could read `_manager` mid-swap and initialize LSP servers against the
 * outgoing manager.
 */
export async function setLspManager(mgr: LspManager): Promise<void> {
	// Serialize against any prior swap still in flight. With the bug fix,
	// `_shutdownPromise` is non-null while a previous manager's shutdown is
	// pending, so concurrent callers wait here instead of racing on `_manager`.
	await awaitPreviousShutdown();

	const prev = _manager;
	if (prev) {
		// Publish the in-flight shutdown so `awaitPreviousShutdown()` callers
		// (e.g. before_agent_start) can wait for it. Cleared in `finally`
		// once shutdown resolves or rejects.
		_shutdownPromise = (async () => {
			try {
				await prev.shutdown();
			} catch (err) {
				_logWarn("setLspManager", "previous LspManager shutdown failed", err);
			}
		})().finally(() => {
			_shutdownPromise = null;
		});
		await _shutdownPromise;
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

// -- Tool timing (shared between tools and tool-logger) --------------------

/**
 * Stores the most recent tool timing data.
 * Tools write to this before returning; tool-logger reads it on tool_result.
 * Safe because tools execute sequentially (one tool call at a time).
 */
let _lastToolTiming: Record<string, number> | null = null;

/**
 * Store nested timing data from the current tool execution.
 * Called by tools that have per-stage timing instrumentation.
 */
export function setLastToolTiming(laps: Record<string, number>): void {
	_lastToolTiming = laps;
}

/**
 * Retrieve and clear the last tool timing data.
 * Called by tool-logger after a tool result event.
 */
export function consumeLastToolTiming(): Record<string, number> | null {
	const laps = _lastToolTiming;
	_lastToolTiming = null;
	return laps;
}

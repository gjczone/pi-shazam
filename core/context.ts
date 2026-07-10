/**
 * pi-shazam core/context -- Tool execution timing shared between tools and hooks.
 *
 * Lives in core/ (not tools/) so hooks can consume it without violating the
 * one-way dependency rule (hooks -> tools -> core). The LspManager context
 * stays in tools/_context.ts because it depends on lsp/, which core must not
 * import.
 *
 * Tools write timing via setLastToolTiming before returning; tool-logger
 * reads and clears it via consumeLastToolTiming on the next tool_result.
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

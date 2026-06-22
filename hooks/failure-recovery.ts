/**
 * pi-shazam hooks/failure-recovery — Detect consecutive failures and suggest alternatives.
 *
 * When the LLM repeatedly fails at the same task, this hook:
 * 1. Tracks failure patterns per tool
 * 2. After 3 consecutive failures, suggests a different approach
 * 3. After 5 consecutive failures, strongly suggests reorienting with shazam_overview
 *
 * This prevents LLM loops where it keeps trying the same failing approach.
 *
 * Uses tool_result event with isError flag.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";

/**
 * Stored failure info per tool: consecutive failure count, last error message, and timestamp.
 */
interface FailureInfo {
	count: number;
	lastError: string;
	/** Unix millisecond timestamp of the most recent write, used for TTL eviction. */
	timestamp: number;
}

/**
 * Failure tracker: tool name -> failure info (count, last error, timestamp).
 */
const _failureCounts = new Map<string, FailureInfo>();

/**
 * Track which tools have been warned about, with timestamp for TTL expiry.
 * Map<toolName, timestampMs>
 */
const _warnedTools = new Map<string, number>();

/** TTL for failure/warning entries: 1 hour in milliseconds. */
const FAILURE_TTL_MS = 60 * 60 * 1000;

/**
 * Clean up entries older than FAILURE_TTL_MS from both maps.
 * Called on every write to prevent unbounded growth (issue #368).
 */
function _cleanupExpiredEntries(): void {
	const cutoff = Date.now() - FAILURE_TTL_MS;
	for (const [tool, info] of _failureCounts) {
		if (info.timestamp < cutoff) _failureCounts.delete(tool);
	}
	for (const [tool, ts] of _warnedTools) {
		if (ts < cutoff) _warnedTools.delete(tool);
	}
}

/**
 * Reset failure count for a tool (called on success).
 */
function resetFailure(toolName: string): void {
	_failureCounts.delete(toolName);
	_warnedTools.delete(toolName);
}

/**
 * Increment failure count and track the error message.
 * Returns the new failure count.
 */
function incrementFailure(toolName: string, errorMessage: string): number {
	_cleanupExpiredEntries();
	const current = _failureCounts.get(toolName);
	const newCount = (current?.count || 0) + 1;
	_failureCounts.set(toolName, { count: newCount, lastError: errorMessage, timestamp: Date.now() });
	return newCount;
}

/**
 * Analyze error message and return a human-readable description.
 */
function analyzeError(errorMessage: string): string {
	const lower = errorMessage.toLowerCase();
	if (lower.includes("file not found") || lower.includes("enoent")) {
		return "The error is: file not found. The target path may be incorrect.";
	}
	if (lower.includes("permission") || lower.includes("eacces")) {
		return "The error is: permission denied. Check file access rights.";
	}
	if (lower.includes("network") || lower.includes("enotfound") || lower.includes("econnrefused")) {
		return "The error is: network issue. The remote resource may be unavailable.";
	}
	if (lower.includes("type") || lower.includes("syntax")) {
		return "The error is: type/syntax error. Run shazam_verify to check.";
	}
	if (lower.includes("timeout") || lower.includes("timed out")) {
		return "The error is: timeout. The operation took too long.";
	}
	return "Repeated failures detected.";
}

/**
 * Get suggestion based on failure count, tool type, and error message.
 */
function getSuggestion(toolName: string, failCount: number, errorMessage: string): string | null {
	const lowerError = errorMessage.toLowerCase();

	// After 5 failures: strong intervention (error-specific)
	if (failCount >= 5) {
		const analysis = analyzeError(errorMessage);
		return [
			"[shazam] You've been stuck for a while.",
			"",
			analysis,
			"",
			"Consider:",
			"1. Run `shazam_overview` to reorient yourself",
			"2. Simplify the current task",
			"3. Ask the user for clarification",
		].join("\n");
	}

	// After 3 failures: specific suggestions
	if (failCount >= 3 && !_warnedTools.has(toolName)) {
		_warnedTools.set(toolName, Date.now());

		// Error-type-specific suggestions
		if (lowerError.includes("file not found") || lowerError.includes("enoent")) {
			return [
				"[shazam] File not found error repeated 3x.",
				"",
				"Try:",
				"- Run `shazam_lookup --file <path>` to check if the file exists",
				"- Use `shazam_lookup --file <filename>` to locate the file",
				"- Check if the file was renamed, moved, or deleted",
			].join("\n");
		}

		if (lowerError.includes("permission denied") || lowerError.includes("eacces")) {
			return [
				"[shazam] Permission denied error repeated 3x.",
				"",
				"Try:",
				"- Check file/directory permissions",
				"- Ensure the path is writable",
				"- Run with appropriate privileges",
			].join("\n");
		}

		if (
			lowerError.includes("enotfound") ||
			lowerError.includes("econnrefused") ||
			lowerError.includes("etimedout") ||
			lowerError.includes("network")
		) {
			return [
				"[shazam] Network error repeated 3x.",
				"",
				"Try:",
				"- Check your network connection",
				"- Verify the URL is accessible",
				"- Retry with a longer timeout",
			].join("\n");
		}

		if (lowerError.includes("cannot find module") || lowerError.includes("cannot find package")) {
			return [
				"[shazam] Module not found error repeated 3x.",
				"",
				"Try:",
				"- Run `npm install` or `pip install` to install dependencies",
				"- Check import paths are correct",
				"- Verify the package exists in package.json",
			].join("\n");
		}

		// Fallback to tool-type-specific suggestions
		switch (toolName) {
			case "bash":
				return [
					"[shazam] Bash command failed 3x consecutively.",
					"",
					"Try a different approach:",
					"- Use `shazam_lookup` instead of grep/find",
					"- Use `shazam_lookup` to understand file structure first",
					"- Break the command into smaller steps",
				].join("\n");

			case "edit":
				return [
					"[shazam] Edit failed 3x consecutively.",
					"",
					"Try:",
					"- Use `shazam_lookup` to see the current file structure",
					"- Use `shazam_lookup` to understand the symbol you're editing",
					"- Read the file first with `read` to see current content",
				].join("\n");

			case "write":
				return [
					"[shazam] Write failed 3x consecutively.",
					"",
					"Try:",
					"- Check if the directory exists",
					"- Use `shazam_impact` to check if the file is referenced elsewhere",
				].join("\n");

			default:
				return [
					`[shazam] ${toolName} failed 3x consecutively.`,
					"",
					"Consider running `shazam_overview` to reorient.",
				].join("\n");
		}
	}

	return null;
}

/**
 * Extract a human-readable error string from a tool_result event.
 */
function extractErrorText(event: { content?: unknown; error?: unknown }): string {
	// Try to get error from event.error first
	if (typeof event.error === "string") return event.error;
	if (event.error instanceof Error) return event.error.message;
	// Try to get from content
	if (Array.isArray(event.content)) {
		for (const item of event.content) {
			if (item && typeof item === "object" && "text" in item && typeof (item as { text: string }).text === "string") {
				return (item as { text: string }).text;
			}
		}
	}
	return "Unknown error";
}

/**
 * Register the failure-recovery hook.
 *
 * On tool_result with isError, tracks failures and suggests alternatives
 * after repeated failures.
 */
export function registerFailureRecovery(pi: ExtensionAPI): void {
	pi.on("tool_result", (event, _ctx) => {
		const toolName = event.toolName;

		if (event.isError) {
			// Extract error text and track failure
			const errorText = extractErrorText(event);
			const failCount = incrementFailure(toolName, errorText);
			const suggestion = getSuggestion(toolName, failCount, errorText);

			if (suggestion) {
				pi.sendMessage({
					customType: "shazam-failure-recovery",
					content: suggestion,
					display: false, // Inject into context, not UI
				});
			}
		} else {
			// Success — reset failure count
			resetFailure(toolName);
		}
	});

	// Reset all counts on session start
	pi.on("session_start", () => {
		_failureCounts.clear();
		_warnedTools.clear();
	});
}

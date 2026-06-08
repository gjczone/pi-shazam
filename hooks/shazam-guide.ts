/**
 * Guide the agent to use shazam tools at the right moments.
 *
 * Injects context reminders at key lifecycle points:
 * - before_agent_start: inject shazam tool list into system prompt
 * - tool_result (write/edit): suggest running shazam_verify
 * - tool_result (shazam_symbol): suggest call_chain when symbol has many callers
 * - tool_call (search/grep/find): suggest shazam_codesearch
 * - tool_call (write/edit): suggest shazam_impact for multi-file edits
 */
import type { ExtensionAPI } from "../types/pi-extension.js";

/**
 * Check if a tool result contains caller count and suggest call_chain for high-risk symbols.
 */
function hasManyCallers(content: unknown[] | undefined): string | null {
	if (!content) return null;
	for (const item of content) {
		if (item && typeof item === "object" && "text" in item) {
			const text = (item as { text: string }).text;
			// Look for caller count patterns: "N callers" or "N references"
			const callerMatch = text.match(/(\d+) callers?/i);
			const refMatch = text.match(/(\d+) references?/i);
			const symbolMatch = text.match(/`([^`]+)`/);
			const symbolName = symbolMatch ? symbolMatch[1] : null;

			// Extract the actual number (callers is more precise than references)
			const count = callerMatch
				? parseInt(callerMatch[1], 10)
				: refMatch
					? parseInt(refMatch[1], 10)
					: 0;

			if (count >= 5 && symbolName) {
				return symbolName;
			}
		}
	}
	return null;
}

/**
 * Check if tool result mentions multiple changed files (for impact suggestion).
 */
function hasMultiFileEdit(content: unknown[] | undefined): boolean {
	if (!content) return false;
	for (const item of content) {
		if (item && typeof item === "object" && "text" in item) {
			const text = (item as { text: string }).text;
			const fileMatches = text.match(/(\d+) files?/gi);
			if (fileMatches) {
				for (const m of fileMatches) {
					const num = parseInt(m.match(/\d+/)?.[0] || "0", 10);
					if (num >= 2) return true;
				}
			}
		}
	}
	return false;
}

export function registerShazamGuide(pi: ExtensionAPI): void {
	// Tool list injection removed — the before-start hook's overview already
	// covers all tool guidance. Keeping only contextual lifecycle notifications.

	pi.on("tool_result", (event, ctx) => {
		// After write/edit: suggest impact analysis for multi-file edits only
		if (event.toolName === "write" || event.toolName === "edit") {
			if (event.isError) return;

			// Check if multi-file edit was done — suggest impact analysis
			if (hasMultiFileEdit(event.content)) {
				ctx.ui?.notify?.(
					"suggestion: you edited multiple files — shazam_impact assesses blast radius before continuing",
					"info",
				);
			}
			return;
		}

		// After shazam_symbol: suggest call_chain for symbols with many callers
		if (event.toolName === "shazam_symbol") {
			const symbolName = hasManyCallers(event.content);
			if (symbolName && !event.isError) {
				ctx.ui?.notify?.(
					`recommended: shazam_call_chain --symbol ${symbolName} traces all callers before changing this symbol`,
					"info",
				);
			}
			return;
		}

		// After shazam_verify FAIL/WARN: suggest remediation
		if (event.toolName === "shazam_verify" && !event.isError) {
			const texts: string[] = [];
			if (event.content) {
				for (const c of event.content) {
					if (typeof c === "object" && "text" in c) texts.push((c as { text: string }).text);
				}
			}
			const combined = texts.join("\n");
			if (combined.includes("[FAIL]")) {
				ctx.ui?.notify?.("shazam_verify reported FAIL — fix errors before proceeding", "warning");
			} else if (combined.includes("[WARN]")) {
				ctx.ui?.notify?.("shazam_verify reported WARN — review warnings, then run shazam_fix if needed", "info");
			}
			return;
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const name = event.toolName;

		// Before impact: suggest verifying first if there are uncommitted changes
		if (name === "shazam_impact") {
			ctx.ui?.notify?.("tip: run shazam_verify first to establish a baseline before assessing impact", "info");
			return;
		}

		// Before rename_symbol: suggest call_chain first
		if (name === "shazam_rename_symbol") {
			ctx.ui?.notify?.("tip: run shazam_call_chain first to verify all references before renaming", "info");
			return;
		}
	});
}

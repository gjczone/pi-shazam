/**
 * Guide the agent to use shazam tools at the right moments.
 *
 * Injects context reminders at key lifecycle points:
 * - before_agent_start: inject shazam tool list into system prompt
 * - tool_result (write/edit): suggest running shazam_verify
 * - tool_call (search/grep/find): suggest shazam_codesearch
 */
import type { ExtensionAPI } from "../types/pi-extension.js";

export function registerShazamGuide(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, _ctx) => {
		const guide = [
			"",
			"14 pi-shazam tools available this session:",
			"  shazam_overview — project structure, deps, git history in one call",
			"  shazam_impact   — check blast radius before editing multiple files",
			"  shazam_codesearch — ranked code search, more precise than grep",
			"  shazam_symbol   — locate a function/class definition and its callers",
			"  shazam_hover     — type signatures and JSDoc via LSP",
			"  shazam_file_detail — see all symbols and dependencies in a file",
			"  shazam_call_chain — trace every caller before changing a function",
			"  shazam_find_tests — discover test files for any module",
			"  shazam_hotspots  — find the most complex, highest-risk files",
			"  shazam_type_hierarchy — full class inheritance chain",
			"  shazam_verify    — check for errors after every edit (PASS/WARN/FAIL)",
			"  shazam_fix       — auto-fix format and lint issues",
			"  shazam_rename_symbol  — safe rename, verify references first",
			"  shazam_safe_delete    — confirm zero references before removing",
			"",
		];

		const current = _event.systemPrompt;
		if (current.some((s) => s.includes("pi-shazam tools available"))) return;
		current.push(...guide);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (event.isError) return;
		ctx.ui?.notify?.("reminder: shazam_verify checks for errors after editing", "info");
	});

	pi.on("tool_call", (event, ctx) => {
		const name = event.toolName;
		if (name !== "search" && name !== "grep" && name !== "find") return;
		ctx.ui?.notify?.("reminder: shazam_codesearch gives ranked results, try it instead of grep", "info");
	});
}

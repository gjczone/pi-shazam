/**
 * Guide the agent to use shazam tools at appropriate moments.
 *
 * Injects context reminders at key lifecycle points:
 * - before_agent_start: inject shazam tool guidance into system prompt
 * - tool_result (write/edit): suggest running shazam_verify
 * - tool_call (read/grep): suggest using shazam tools instead
 */
import type { ExtensionAPI } from "../types/pi-extension.js";

export function registerShazamGuide(pi: ExtensionAPI): void {
	// ── Before agent starts: inject shazam usage guidance ──────────
	pi.on("before_agent_start", (_event, _ctx) => {
		// Append shazam guidance to system prompt so the agent always
		// knows these tools are available and when to use them.
		const guide = [
			"",
			"--- pi-shazam tools available ---",
			"shazam_overview — first call in any project (structure, deps, git history)",
			"shazam_impact   — before editing 2+ files or shared modules",
			"shazam_verify   — after every non-trivial edit (PASS/WARN/FAIL)",
			"shazam_symbol   — before importing or calling any symbol",
			"shazam_call_chain — before changing function signatures",
			"shazam_codesearch — use instead of grep for code search",
			"shazam_fix      — auto-fix format/lint errors from verify",
			"Full list: shazam_file_detail, shazam_hover, shazam_find_tests,",
			"shazam_hotspots, shazam_type_hierarchy, shazam_rename_symbol,",
			"shazam_safe_delete",
			"",
		];

		const current = _event.systemPrompt;
		// Avoid double-injection
		if (current.some((s) => s.includes("pi-shazam tools available"))) return;

		current.push(...guide);
	});

	// ── After write/edit: nudge to verify ─────────────────────────
	pi.on("tool_result", (event, ctx) => {
		const name = event.toolName;
		if (name !== "write" && name !== "edit") return;
		if (event.isError) return;

		// Send a gentle reminder — non-blocking, informational
		ctx.ui?.notify?.("shazam: run shazam_verify to confirm no errors", "info");
	});

	// ── When agent uses grep/find instead of shazam ────────────────
	pi.on("tool_call", (event, ctx) => {
		const name = event.toolName;
		if (name !== "search" && name !== "grep" && name !== "find") return;

		// Remind agent that shazam_codesearch exists
		ctx.ui?.notify?.("shazam: try shazam_codesearch for ranked results", "info");
	});
}

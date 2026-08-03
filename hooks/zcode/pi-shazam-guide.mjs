/**
 * pi-shazam ZCode hook -- scenario-based prompt injection for the shazam tools.
 *
 * ZCode config hooks cannot call the tools directly; they inject
 * `additionalContext` text at key lifecycle moments so the agent knows
 * when to use the shazam_* tools.
 *
 * Tool names are written in their generic form (shazam_overview, ...) so the
 * prompts read naturally for the majority of users, who run pi-shazam as a Pi
 * extension. In MCP clients (ZCode, Cursor, Claude Desktop, ...) the same tools
 * are exposed with the `mcp__pi-shazam__` prefix.
 *
 * Usage: node pi-shazam-guide.mjs <scenario>
 *   session        -- SessionStart (startup/resume): tool usage guide
 *   impact-check   -- UserPromptSubmit matching impact keywords
 *   lookup-hint    -- UserPromptSubmit matching symbol/query keywords
 *   pre-edit       -- PreToolUse on Edit/Write/ApplyPatch
 *   post-edit      -- PostToolUse on Edit/Write/ApplyPatch
 *   failure        -- PostToolUseFailure on Edit/Write/Bash
 *
 * Output contract: strict JSON on stdout. The ZCode hook schema only
 * accepts { "additionalContext": string }; any extra key fails validation.
 * Unknown scenarios log to stderr and exit 0 with empty output so the
 * session is never blocked or errored by a bad argument.
 */

"use strict";

const TOOLS = {
	overview: "shazam_overview",
	lookup: "shazam_lookup",
	impact: "shazam_impact",
	verify: "shazam_verify",
	changes: "shazam_changes",
	format: "shazam_format",
	rename: "shazam_rename_symbol",
};

const SCENARIOS = {
	session: `This session has pi-shazam code analysis tools available (7 tools). Use them as needed for code tasks:
- ${TOOLS.overview}: project structure overview, hotspot files, dependency graph -- use it first when entering a new project or before a large change
- ${TOOLS.lookup}: symbol/file definitions, callers, type hierarchy -- for any "what does this function do / where is it defined / who calls it" question
- ${TOOLS.impact}: change blast-radius analysis (affected files, reverse references) -- before modifying code
- ${TOOLS.verify}: post-edit validation (type diagnostics + dependency graph consistency) -- after editing
- ${TOOLS.changes}: working-tree change summary; ${TOOLS.format}: auto-fix formatting; ${TOOLS.rename}: safe symbol rename
Convention: overview/impact before touching code, verify after editing.`,

	"impact-check": `The user request involves code changes or impact analysis. Call ${TOOLS.impact} first to analyze the blast radius (affected files, reverse references) before proposing or applying any change.`,

	"lookup-hint": `The user request involves looking up symbols or understanding code. Call ${TOOLS.lookup} (accepts a symbol name or a file path; returns definition, type hierarchy, callers/callees) for accurate information instead of guessing.`,

	"pre-edit": `About to modify code. If the change spans multiple files or touches shared modules, call ${TOOLS.impact} first to confirm the blast radius (which callers are affected) and avoid breaking unexpected code.`,

	"post-edit": `Code edit completed. Call ${TOOLS.verify} to validate the change (type diagnostics + dependency graph consistency). Fix any findings immediately before continuing; do not deliver unverified changes.`,

	failure: `A tool failed. Use ${TOOLS.lookup} to inspect the relevant symbols or files, or ${TOOLS.verify} to check the code state; do not silently bypass the failure or pretend success.`,
};

function main() {
	const scenario = process.argv[2] || "";
	const text = SCENARIOS[scenario];
	if (!text) {
		// Safety fallback: log the bad argument, emit nothing, never fail the hook.
		console.error(`[pi-shazam-guide] unknown scenario: ${scenario}`);
		process.exit(0);
	}
	console.log(JSON.stringify({ additionalContext: text }));
}

main();

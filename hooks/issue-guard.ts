/**
 * pi-shazam hooks/issue-guard -- GitHub issue creation detector.
 *
 * Intercepts bash tool_call events to detect `gh issue create` commands.
 * When a serious issue (bug/crash/error) is created, sets a pending impact
 * flag that blocks subsequent file edits until shazam_impact is run.
 *
 * Trivial issues (chore/docs/typo) do not trigger the flag.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { setPendingImpact, clearPendingImpact } from "./impact-state.js";
import { tokenizeCommand, extractCommandFromEvent } from "./_bash-utils.js";

/**
 * Patterns that indicate a serious issue requiring impact analysis.
 */
const SERIOUS_PATTERNS = /\b(fix|bug|P0|P1|crash|error|broken|fail)\b/i;

/**
 * Patterns that indicate a trivial issue not requiring impact analysis.
 */
const TRIVIAL_PATTERNS = /chore|docs|typo|readme/i;

/** Cooldown between isError-triggered impact flag sets (30s). */
let _lastErrorFlagTime = 0;
const ERROR_COOLDOWN_MS = 30_000;

/**
 * Register the issue guard hook.
 *
 * On bash tool_call: detects `gh issue create` via argv-based parsing.
 * On isError tool_result: sets pending impact with 30s cooldown.
 * On shazam_impact tool_result: clears the pending impact flag.
 * On session_start: resets the pending impact flag.
 */
export function registerIssueGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;

		const command = extractCommandFromEvent(event);

		// argv-based gh issue create detection
		const argv = tokenizeCommand(command);
		const isGhIssueCreate = argv[0] === "gh" && argv.length >= 3 && argv[1] === "issue" && argv[2] === "create";
		if (!isGhIssueCreate) return;

		// Classify severity from title/body patterns in the command
		const isSerious = SERIOUS_PATTERNS.test(command);
		const isTrivial = TRIVIAL_PATTERNS.test(command);

		if (isSerious && !isTrivial) {
			setPendingImpact();
		}
	});

	// Clear pending impact when shazam_impact completes
	pi.on("tool_result", (event) => {
		if (event.toolName === "shazam_impact" && !event.isError) {
			clearPendingImpact();
		}

		// On isError from bash: set pending impact with 30s cooldown,
		// scoped to gh/npm-test commands that indicate workflow failures
		if (event.isError && event.toolName === "bash") {
			const cmd = extractCommandFromEvent(event);
			if (/\b(gh|npm\s+(test|run\s+test))\b/.test(cmd)) {
				const now = Date.now();
				if (now - _lastErrorFlagTime > ERROR_COOLDOWN_MS) {
					_lastErrorFlagTime = now;
					setPendingImpact();
				}
			}
		}
	});

	// Reset pending impact on session start
	pi.on("session_start", () => {
		clearPendingImpact();
		_lastErrorFlagTime = 0;
	});
}

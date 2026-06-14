/**
 * pi-shazam hooks/issue-guard — GitHub issue creation detector.
 *
 * Intercepts bash tool_call events to detect `gh issue create` commands.
 * When a serious issue (bug/crash/error) is created, sets a pending impact
 * flag that blocks subsequent file edits until shazam_impact is run.
 *
 * Trivial issues (chore/docs/typo) do not trigger the flag.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { setPendingImpact, clearPendingImpact } from "./impact-state.js";

/**
 * Patterns that indicate a serious issue requiring impact analysis.
 */
const SERIOUS_PATTERNS = /fix|bug|P0|P1|crash|error|broken|fail/i;

/**
 * Patterns that indicate a trivial issue not requiring impact analysis.
 */
const TRIVIAL_PATTERNS = /chore|docs|typo|readme/i;

/**
 * Register the issue guard hook.
 *
 * On bash tool_call: detects `gh issue create` and classifies severity.
 * On shazam_impact tool_result: clears the pending impact flag.
 * On session_start: resets the pending impact flag.
 */
export function registerIssueGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;

		const input = "input" in event ? (event as unknown as Record<string, unknown>).input : {};
		const command = ((input as Record<string, unknown>).command as string) || "";

		if (!command.includes("gh issue create")) return;

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
	});

	// Reset pending impact on session start
	pi.on("session_start", () => {
		clearPendingImpact();
	});
}

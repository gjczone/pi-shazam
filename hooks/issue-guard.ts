/**
 * pi-shazam hooks/issue-guard -- GitHub issue creation logger.
 *
 * Logs `gh issue create` commands to internal.log for observability.
 * Does NOT block or set pending-impact flags (subagent-safe).
 *
 * Trivial issues (chore/docs/typo) are not logged.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { tokenizeSegments, extractCommandFromEvent } from "./_bash-utils.js";
import { _logInternal } from "../core/output.js";

/**
 * Patterns that indicate a serious issue.
 */
const SERIOUS_PATTERNS = /\b(fix|bug|P0|P1|crash|error|broken|fail)\b/i;

/**
 * Patterns that indicate a trivial issue.
 */
const TRIVIAL_PATTERNS = /chore|docs|typo|readme/i;

/** Cooldown for error logging (30s). */
let _lastErrorTime = 0;
const ERROR_COOLDOWN_MS = 30_000;

/**
 * Register the issue guard hook.
 *
 * Does NOT block anything -- only logs to internal.log.
 */
export function registerIssueGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;

		const command = extractCommandFromEvent(event);

		// #467: segment-aware gh issue create detection
		const segments = tokenizeSegments(command);
		const isGhIssueCreate = segments.some(
			(seg) => seg[0] === "gh" && seg.length >= 3 && seg[1] === "issue" && seg[2] === "create",
		);
		if (!isGhIssueCreate) return;

		const isSerious = SERIOUS_PATTERNS.test(command);
		const isTrivial = TRIVIAL_PATTERNS.test(command);

		if (isSerious && !isTrivial) {
			_logInternal("issue-guard", "serious issue created", { issueType: "serious", cmd: command?.slice(0, 200) });
		}
	});

	// Log bash errors with cooldown
	pi.on("tool_result", (event) => {
		if (event.isError && event.toolName === "bash") {
			const cmd = extractCommandFromEvent(event);
			const issueGuardErrorRe = /\b(gh|npm\s+(test|run\s+test))\b/;
			if (issueGuardErrorRe.test(cmd)) {
				const now = Date.now();
				if (now - _lastErrorTime > ERROR_COOLDOWN_MS) {
					_lastErrorTime = now;
					_logInternal("issue-guard", "bash error detected", { issueType: "error", cmd: cmd?.slice(0, 200) });
				}
			}
		}
	});
}

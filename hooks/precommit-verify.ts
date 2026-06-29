/**
 * pi-shazam hooks/precommit-verify -- Pre-commit verification reminder.
 *
 * When the agent runs `git commit` without `--no-verify`, sends a steer
 * message suggesting to run `shazam_verify --preCommit` first.
 *
 * Does NOT block the commit -- just reminds. This is safer for automated
 * subagents (Swarm, workflow phases) that cannot interact with dialogs.
 *
 * Quality enforcement happens in CI, not in pre-commit hooks.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { tokenizeSegments, extractCommandFromEvent } from "./_bash-utils.js";
import { _logInternal } from "../core/output.js";

/**
 * Register the pre-commit verification reminder hook.
 *
 * On bash tool_call: detects `git commit` via argv-based parsing.
 * Sends a steer message to suggest running verify first.
 * Does NOT block the command.
 */
export function registerPrecommitVerify(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, _ctx) => {
		if (event.toolName !== "bash") return;

		const cmd = extractCommandFromEvent(event);
		if (!cmd) return;

		// #467: segment-aware git commit detection.
		const segments = tokenizeSegments(cmd);
		const gitCommitSeg = segments.find(
			(seg) => seg[0] === "git" && seg.length >= 2 && seg[1] === "commit",
		);
		if (!gitCommitSeg) return;

		// Skip if --no-verify or -n flag is present (user explicitly bypassing)
		const hasNoVerify =
			gitCommitSeg.includes("--no-verify") ||
			gitCommitSeg.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("n"));
		if (hasNoVerify) return;

		// Send a reminder steer message
		_logInternal("precommit-verify", "commit detected, verification reminder sent", {
			cmd: cmd.slice(0, 200),
		});

		pi.sendMessage(
			{
				customType: "shazam-reminder",
				content: [
					"[shazam] Commit detected -- remember to verify first",
					"",
					"Run `shazam_verify --preCommit` before committing to catch type errors,",
					"lint issues, and broken references early.",
					"",
					"To skip this reminder: `git commit --no-verify`",
				].join("\n"),
				display: false,
			},
			{
				triggerTurn: false,
				deliverAs: "steer",
			},
		);
	});
}

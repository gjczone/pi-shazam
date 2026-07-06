/**
 * pi-shazam hooks/precommit-verify -- Auto-run verify before commit.
 *
 * When the agent runs `git commit` without `--no-verify`, automatically
 * runs `shazam_verify --preCommit` and sends the results to the LLM.
 *
 * Does NOT block the commit -- the LLM sees the results and can decide
 * to fix issues. --no-verify is available only when the LLM is certain
 * the reported issues are false positives.
 *
 * Quality enforcement happens in CI, not in pre-commit hooks.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import type { VerifyOptions } from "../tools/verify.js";
import { tokenizeSegments, extractCommandFromEvent } from "./_bash-utils.js";
import { _logInternal } from "../core/output.js";

/**
 * Register the pre-commit auto-verify hook.
 *
 * On bash tool_call: detects `git commit` via argv-based parsing.
 * Auto-runs `shazam_verify --preCommit` and sends results to LLM.
 * Does NOT block the command.
 */
export function registerPrecommitVerify(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash") return;

		const cmd = extractCommandFromEvent(event);
		if (!cmd) return;

		// #467: segment-aware git commit detection.
		const segments = tokenizeSegments(cmd);
		const gitCommitSeg = segments.find((seg) => seg[0] === "git" && seg.length >= 2 && seg[1] === "commit");
		if (!gitCommitSeg) return;

		// Skip if --no-verify or -n flag is present (user explicitly bypassing)
		const hasNoVerify =
			gitCommitSeg.includes("--no-verify") ||
			gitCommitSeg.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("n"));
		if (hasNoVerify) return;

		// Auto-run shazam_verify --preCommit
		_logInternal("precommit-verify", "commit detected, auto-running verify", {
			cmd: cmd.slice(0, 200),
			cwd: ctx.cwd,
		});

		(async () => {
			try {
				const { executeVerifyTextAsync } = await import("../tools/verify.js");
				const opts: VerifyOptions = {
					preCommit: true,
					quick: false,
					lspOnly: false,
				};
				const result = await executeVerifyTextAsync(ctx.cwd, opts);

				// Truncate long results for the steer message
				const lines = result.split("\n");
				const truncated = lines.length > 60 ? lines.slice(0, 60).join("\n") + "\n... (truncated)" : result;

				pi.sendMessage(
					{
						customType: "shazam-reminder",
						content: [
							"[shazam] Auto-verify before commit:",
							"",
							truncated,
							"",
							"Please fix any issues above before committing.",
						].join("\n"),
						display: false,
					},
					{
						triggerTurn: false,
						deliverAs: "steer",
					},
				);
			} catch (err) {
				_logInternal("precommit-verify", "auto-verify failed", {
					err: err instanceof Error ? err.message : String(err),
				});
			}
		})();
	});
}

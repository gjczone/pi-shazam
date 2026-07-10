/**
 * pi-shazam hooks/precommit-verify -- Auto-run verify before commit.
 *
 * When the agent runs `git commit` without `--no-verify`/`-n`, automatically
 * runs `shazam_verify --preCommit` and sends the results to the LLM as a
 * non-blocking reference.
 *
 * Does NOT block the commit -- the LLM sees the results and decides whether
 * to fix issues. The hook never gates the commit; quality enforcement is the
 * job of CI. --no-verify/`-n` is honored when the LLM is certain the reported
 * issues are false positives.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import type { VerifyOptions } from "../core/verify-types.js";
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

		// Skip if --no-verify or -n flag is present (user explicitly bypassing).
		// -n is the short form of --no-verify; only that exact flag is honored,
		// so other short options containing "n" (e.g. none in git commit's common
		// set) are not mistaken for a bypass.
		const hasNoVerify = gitCommitSeg.includes("--no-verify") || gitCommitSeg.includes("-n");
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
						customType: "shazam-commit-verify",
						content: [
							"[shazam] Pre-commit auto-verify (non-blocking reference):",
							"",
							truncated,
							"",
							"Review the above at your discretion. The commit is not blocked; fix any real issues you agree with, or proceed if they are false positives.",
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

/**
 * pi-shazam hooks/stop-verify — Remind to verify before ending turn.
 *
 * When the LLM tries to end its turn after making edits, this hook checks
 * if shazam_verify was run. If not, it sends a reminder message.
 *
 * This prevents the common pattern where LLM edits files and forgets
 * to check for errors before declaring "done".
 *
 * Uses turn_end event to detect when the agent is about to finish.
 * Tracks verify calls via shared verify-state module.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { getEditedFiles, clearEditedFiles } from "./pre-edit.js";
import { markVerifyCalled, hasRecentVerify, onNewEdit, resetVerifyState } from "./verify-state.js";

/**
 * Register the stop-verify hook.
 *
 * On tool_result for shazam_verify, marks verify as called and clears edit tracker.
 * On tool_call for write/edit after verify, resets verify flag (post-verify edit detection).
 * On turn_end, checks if there were file edits that haven't been verified.
 */
export function registerStopVerify(pi: ExtensionAPI): void {
	// Track shazam_verify calls and clear edit history (edits are now verified)
	pi.on("tool_result", (event) => {
		if (event.toolName === "shazam_verify" && !event.isError) {
			// Extract text from content blocks to parse PASS/FAIL verdict
			const text =
				"content" in event && Array.isArray(event.content)
					? event.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n")
					: undefined;
			markVerifyCalled(text);
			clearEditedFiles();
		}
	});

	// Reset verify flag when new edits happen after verify
	pi.on("tool_call", (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			onNewEdit();
		}
	});

	// Reset on session start
	pi.on("session_start", () => {
		resetVerifyState();
	});

	// Check on turn end
	pi.on("turn_end", (_event, _ctx) => {
		// Check if there were file edits this session
		const editedFiles = getEditedFiles();
		if (editedFiles.length === 0) return;

		// Check if shazam_verify was run recently
		if (hasRecentVerify()) return;

		// Send reminder via sendMessage (injected into next turn context)
		const fileList =
			editedFiles.length <= 3 ? editedFiles.map((f) => `\`${f}\``).join(", ") : `${editedFiles.length} files`;

		pi.sendMessage({
			customType: "shazam-reminder",
			content: [
				"[shazam] Verification reminder",
				"",
				`You edited ${fileList} this session but haven't run \`shazam_verify\`.`,
				"Run it now to check for type errors, lint issues, and broken references.",
			].join("\n"),
			display: false,
		});
	});
}

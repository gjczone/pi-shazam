/**
 * pi-shazam hooks/stop-verify -- Auto-verify guard at turn end.
 *
 * When the LLM tries to end its turn after making edits, this hook checks
 * if shazam_verify was run. If not, it injects a steer message that triggers
 * a new turn with a verification instruction, forcing the agent to run
 * shazam_verify before proceeding.
 *
 * This prevents the common pattern where LLM edits files and forgets
 * to check for errors before declaring "done".
 *
 * Uses turn_end event to detect when the agent is about to finish.
 * Tracks verify calls via shared verify-state module.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { getEditedFiles, clearEditedFiles } from "./pre-edit.js";
import {
	markVerifyCalled,
	hasRecentVerify,
	onNewEdit,
	resetVerifyState,
	markReminderSent,
	wasReminderSent,
	resetReminderSent,
} from "./verify-state.js";
import { _logInternal } from "../core/output.js";

/** Minimum interval between auto-verify steer messages (60 seconds). */
const REMINDER_DEBOUNCE_MS = 60 * 1000;
let _lastReminderTimestamp = 0;

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
		if (event.toolName === "shazam_verify") {
			if (!event.isError) {
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
			} else {
				// #467 Finding 4: verify errored out. The previous reminder's
				// dedup flag (_reminderSent) must be cleared so a future turn_end
				// can re-remind the agent to retry verify. Previously the
				// `if (!event.isError)` guard skipped this branch entirely,
				// leaving _reminderSent stuck true and silencing all subsequent
				// reminders.
				resetReminderSent();
			}
		}
	});

	// Track write/edit calls
	pi.on("tool_call", (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			onNewEdit();
		}
	});

	// Reset on session start
	pi.on("session_start", () => {
		resetVerifyState();
		_lastReminderTimestamp = 0;
	});

	// Check on turn end: if unverified edits exist, inject a steer message
	// that triggers a new turn instructing the agent to run shazam_verify.
	pi.on("turn_end", (_event, _ctx) => {
		// Check if there were file edits this session
		const editedFiles = getEditedFiles();
		if (editedFiles.length === 0) return;

		// Check if shazam_verify was run recently
		if (hasRecentVerify()) return;

		// Skip if a reminder was already sent for this batch of unverified edits
		if (wasReminderSent()) return;

		// Debounce: skip if last reminder was within REMINDER_DEBOUNCE_MS
		const now = Date.now();
		if (now - _lastReminderTimestamp < REMINDER_DEBOUNCE_MS) return;
		_lastReminderTimestamp = now;

		// Build a file list for the message
		const fileList =
			editedFiles.length <= 3 ? editedFiles.map((f) => `\`${f}\``).join(", ") : `${editedFiles.length} files`;

		// Send a steer message that triggers a new turn, forcing the agent
		// to run shazam_verify before continuing. deliverAs: "steer" makes
		// the message more prominent; triggerTurn: true schedules an
		// immediate internal continuation. customType is distinct from the
		// pre-commit verify reminder so the two are not confused.
		_logInternal("stop-verify", "verification reminder sent", { editCount: editedFiles.length });
		pi.sendMessage(
			{
				customType: "shazam-turn-verify",
				content: [
					"[shazam] Turn-end verification required",
					"",
					`You edited ${fileList} this session but haven't run \`shazam_verify\`.`,
					"Run \`shazam_verify\` now to check for type errors, lint issues, and broken references.",
					"After verify passes, continue with your task.",
				].join("\n"),
				display: false,
			},
			{
				triggerTurn: true,
				deliverAs: "steer",
			},
		);

		markReminderSent();
	});
}

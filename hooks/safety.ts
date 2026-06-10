/**
 * pi-shazam hooks/safety — Safety gate for bash commands.
 *
 * Provides two safety features:
 * 1. Destructive command detection — shows confirmation dialog for dangerous commands
 * 2. Pre-commit gate — blocks git commit if shazam_verify was not run recently
 *
 * Uses Pi's ctx.ui.confirm() for interactive confirmation.
 * Uses shared verify-state module for reliable verify detection.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { hasRecentVerify } from "./verify-state.js";

/**
 * High-risk patterns that should always trigger confirmation.
 * Matched as substrings in the command.
 */
const HIGH_RISK_PATTERNS = [
	"rm -rf",
	"rm -fr",
	"rm --recursive",
	"dd if=",
	"mkfs",
	"mkswap",
	"fdisk",
	"parted",
	"sfdisk",
	":(){ :|:& };:", // fork bomb
];

/**
 * Medium-risk patterns that trigger confirmation.
 */
const MEDIUM_RISK_PATTERNS = [
	"chmod -R 777",
	"chmod 777 /",
	"chown -R",
	"> /dev/sd",
	"> /dev/nvme",
	"> /dev/mmcblk",
	"pvcreate",
	"vgcreate",
	"lvcreate",
	"iptables -F",
	"iptables -P",
	"rm -r /",
];

/**
 * Git commit pattern for pre-commit gate.
 */
const GIT_COMMIT_PATTERN = /git\s+commit/;

/**
 * Check if a command matches any destructive pattern.
 * Returns the risk level and matched pattern, or null if safe.
 */
function detectDestructiveCommand(cmd: string): { level: "HIGH" | "MEDIUM"; pattern: string } | null {
	const lower = cmd.toLowerCase();

	for (const pattern of HIGH_RISK_PATTERNS) {
		if (lower.includes(pattern.toLowerCase())) {
			return { level: "HIGH", pattern };
		}
	}

	for (const pattern of MEDIUM_RISK_PATTERNS) {
		if (lower.includes(pattern.toLowerCase())) {
			return { level: "MEDIUM", pattern };
		}
	}

	// Check for rm targeting root
	if (/^rm\s+-(rf|fr|r)\s+\/(\s|$)/.test(cmd)) {
		return { level: "HIGH", pattern: "rm -rf /" };
	}

	return null;
}

/**
 * Register the safety hooks.
 *
 * Intercepts bash tool_call events to:
 * 1. Show confirmation dialog for destructive commands
 * 2. Block git commit if shazam_verify was not run
 */
export function registerSafetyHooks(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		// Only intercept bash commands
		if (event.toolName !== "bash") return;

		const input = "input" in event ? (event as unknown as Record<string, unknown>).input : {};
		const cmd = (input as Record<string, unknown>).command as string;

		if (!cmd || typeof cmd !== "string") return;

		// -- Check 1: Destructive command detection --
		const destructive = detectDestructiveCommand(cmd);
		if (destructive) {
			const emoji = destructive.level === "HIGH" ? "!!!" : "!";
			const message = [
				`[${emoji}] Destructive command detected [${emoji}]`,
				"",
				`Risk level: ${destructive.level}`,
				`Pattern: ${destructive.pattern}`,
				`Command: ${cmd.slice(0, 200)}${cmd.length > 200 ? "..." : ""}`,
				"",
				"Do you want to continue?",
			].join("\n");

			try {
				const confirmed = await ctx.ui.confirm("Safety Warning", message);

				if (!confirmed) {
					return {
						block: true,
						reason: `Command blocked by safety check: ${destructive.pattern}`,
					};
				}

				// User confirmed, allow the command
				ctx.ui.notify(`Proceeding with ${destructive.level}-risk command...`, "warning");
			} catch {
				// If confirm dialog fails (e.g., non-interactive mode), block high-risk
				if (destructive.level === "HIGH") {
					return {
						block: true,
						reason: `High-risk command blocked in non-interactive mode: ${destructive.pattern}`,
					};
				}
				// Allow medium-risk in non-interactive mode
			}

			return;
		}

		// -- Check 2: Pre-commit gate --
		if (GIT_COMMIT_PATTERN.test(cmd)) {
			// Skip if --no-verify flag is present
			if (cmd.includes("--no-verify")) {
				return;
			}

			// Check if shazam_verify was run recently (via shared state)
			if (!hasRecentVerify()) {
				try {
					const choice = await ctx.ui.select("Pre-Commit Gate", [
						"Run shazam_verify first (Recommended)",
						"Skip verification",
						"Cancel commit",
					]);

					if (choice === "Run shazam_verify first (Recommended)") {
						return {
							block: true,
							reason: "Run shazam_verify first, then try committing again.",
						};
					} else if (choice === "Cancel commit") {
						return {
							block: true,
							reason: "Commit cancelled by user.",
						};
					}
					// "Skip verification" — allow the commit
				} catch {
					// Non-interactive mode: just warn but allow
					ctx.ui.notify(
						"[shazam] Tip: Run shazam_verify before committing to catch errors early.",
						"warning",
					);
				}
			}
		}

		return;
	});
}

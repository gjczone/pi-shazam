/**
 * pi-shazam hooks/safety -- Safety gate for bash commands.
 *
 * Provides two safety features:
 * 1. Destructive command detection -- shows confirmation dialog for dangerous commands
 * 2. Pre-commit gate -- blocks git commit if shazam_verify was not run recently
 *
 * Uses Pi's ctx.ui.confirm() for interactive confirmation.
 * Uses shared verify-state module for reliable verify detection.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { hasRecentPassingVerify } from "./verify-state.js";
import { tokenizeCommand, extractCommandFromEvent } from "./_bash-utils.js";

/**
 * High-risk patterns that should always trigger confirmation.
 * Regex patterns catch whitespace-bypass variants (extra spaces, tabs, split flags).
 */
const HIGH_RISK_PATTERNS: Array<{ regex: RegExp; label: string }> = [
	{ regex: /rm\s+(-[a-z]*[rf][a-z]*[rf][a-z]*|-[a-z]*[rf][a-z]*\s+-[a-z]*[rf][a-z]*|--recursive)\b/, label: "rm -rf" },
	{ regex: /dd\s+if=/, label: "dd if=" },
	{ regex: /\bmkfs\b/, label: "mkfs" },
	{ regex: /\bmkswap\b/, label: "mkswap" },
	{ regex: /\bfdisk\b/, label: "fdisk" },
	{ regex: /\bparted\b/, label: "parted" },
	{ regex: /\bsfdisk\b/, label: "sfdisk" },
	{ regex: /:\(\)\s*\{.*:\s*\|\s*:.*&\s*\}.*;/, label: ":(){ :|:& };:" }, // fork bomb (flexible - catches spacing / padding variants)
	{ regex: /\beval\b/, label: "eval" },
	{ regex: /\bsource\s+\S/, label: "source" },
	{ regex: /^\.\s+\S/, label: "source (.)" },
	{ regex: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, label: "curl|sh" },
	{ regex: /\bbase64\b[^|]*\|\s*(sh|bash)\b/, label: "base64|sh" },
	{ regex: /`[^`]+`/, label: "backtick substitution" },
	{ regex: /<\(/, label: "process substitution" },
];

/**
 * Medium-risk patterns that trigger confirmation.
 * Regex patterns catch whitespace-bypass variants.
 */
const MEDIUM_RISK_PATTERNS: Array<{ regex: RegExp; label: string }> = [
	{ regex: /chmod\s+(-R\s+)?777\s+\//, label: "chmod 777 /" },
	{ regex: /chmod\s+-R\s+777/, label: "chmod -R 777" },
	{ regex: /chown\s+-R\b/, label: "chown -R" },
	{ regex: />\s*\/dev\/sd/, label: "> /dev/sd" },
	{ regex: />\s*\/dev\/nvme/, label: "> /dev/nvme" },
	{ regex: />\s*\/dev\/mmcblk/, label: "> /dev/mmcblk" },
	{ regex: /\bpvcreate\b/, label: "pvcreate" },
	{ regex: /\bvgcreate\b/, label: "vgcreate" },
	{ regex: /\blvcreate\b/, label: "lvcreate" },
	{ regex: /iptables\s+-F\b/, label: "iptables -F" },
	{ regex: /iptables\s+-P\b/, label: "iptables -P" },
	{
		regex: /rm\s+(-[a-z]*[rf][a-z]*[rf][a-z]*|-[a-z]*[rf][a-z]*\s+-[a-z]*[rf][a-z]*|--recursive|-r[a-z]*)\s+\//,
		label: "rm -r /",
	},
];

/**
 * Git commit pattern for pre-commit gate.
 */
/**
 * Normalize whitespace in a command string: collapse tabs and multiple spaces
 * to a single space, then trim. This prevents bypass via extra spaces or tabs.
 */
function normalizeWhitespace(cmd: string): string {
	return cmd
		.replace(/[\t\r]+/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/**
 * Check if a command matches any destructive pattern.
 * Uses argv-based parsing for robust matching.
 * Returns the risk level and matched pattern, or null if safe.
 */
function detectDestructiveCommand(cmd: string): { level: "HIGH" | "MEDIUM"; pattern: string } | null {
	const normalized = normalizeWhitespace(cmd);
	const lower = normalized.toLowerCase();
	const argv = tokenizeCommand(cmd);

	// Check via argv for more precise detection
	const argv0 = argv[0]?.toLowerCase() ?? "";
	const isRm = argv0 === "rm" || argv0.endsWith("/rm");

	// rm detection: check for recursive flag
	if (isRm) {
		const hasRecursive = argv.some((a) => {
			if (a === "--recursive") return true;
			if (a === "-r" || a === "-R") return true;
			// Split combined short flags like -rfv, -Rf to check for individual r/R
			if (a.startsWith("-") && !a.startsWith("--") && a.length > 2) {
				return [...a.slice(1)].some((ch) => ch === "r" || ch === "R");
			}
			return false;
		});
		if (hasRecursive) {
			return { level: "HIGH", pattern: "rm -r" };
		}
	}

	for (const { regex, label } of HIGH_RISK_PATTERNS) {
		if (regex.test(lower)) {
			return { level: "HIGH", pattern: label };
		}
	}

	for (const { regex, label } of MEDIUM_RISK_PATTERNS) {
		if (regex.test(lower)) {
			return { level: "MEDIUM", pattern: label };
		}
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

		const cmd = extractCommandFromEvent(event);
		if (!cmd) return;

		// -- Check 1: Destructive command detection --
		const destructive = detectDestructiveCommand(cmd);
		if (destructive) {
			const levelTag = destructive.level === "HIGH" ? "HIGH" : "MED";
			const message = [
				`[${levelTag}] Destructive command detected [${levelTag}]`,
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
			} catch (err) {
				// If confirm dialog fails (e.g., non-interactive mode), block high-risk
				console.warn("[pi-shazam] registerSafetyHooks: confirm dialog failed", err);
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
		// Auto-block commit when shazam_verify was not run recently.
		// Uses argv-based detection to avoid false positives.
		const argv = tokenizeCommand(cmd);
		const isGitCommit = argv[0] === "git" && argv.length >= 2 && argv[1] === "commit";
		if (isGitCommit) {
			// Skip if --no-verify or -n flag is present
			// Use argv.some to handle combined short flags like -nq, -qn
			const hasNoVerify =
				argv.includes("--no-verify") || argv.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("n"));
			if (hasNoVerify) {
				return;
			}

			if (!hasRecentPassingVerify()) {
				return {
					block: true,
					reason: [
						"Commit blocked: shazam_verify --preCommit has not passed.",
						"",
						"Run: shazam_verify --preCommit",
						"If it FAILs: fix the reported issues (type errors, new orphans, lint), then re-run verify.",
						"Once verify reports [PASS] READY: retry your commit.",
						"To skip this check: git commit --no-verify",
					].join("\n"),
				};
			}
		}

		return;
	});
}

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
import { hasRecentPassingVerify } from "./verify-state.js";

/**
 * High-risk patterns that should always trigger confirmation.
 * Regex patterns catch whitespace-bypass variants (extra spaces, tabs, split flags).
 */
const HIGH_RISK_PATTERNS: Array<{ regex: RegExp; label: string }> = [
	{ regex: /rm\s+(-[rRfF]{2,}|-(?:r|f)\s+-(?:r|f)|--recursive)\b/, label: "rm -rf" },
	{ regex: /dd\s+if=/, label: "dd if=" },
	{ regex: /\bmkfs\b/, label: "mkfs" },
	{ regex: /\bmkswap\b/, label: "mkswap" },
	{ regex: /\bfdisk\b/, label: "fdisk" },
	{ regex: /\bparted\b/, label: "parted" },
	{ regex: /\bsfdisk\b/, label: "sfdisk" },
	{ regex: /:\(\)\s*\{\s*:\|:&\s*\};:/, label: ":(){ :|:& };:" }, // fork bomb
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
	{ regex: /rm\s+(-[rRfF]{2,}|-(?:r|f)\s+-(?:r|f)|--recursive|-r)\s+\//, label: "rm -r /" },
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
 * Tokenize a bash command string into argv, respecting quotes.
 * Handles single quotes, double quotes, and escaped characters.
 */
function tokenizeCommand(cmd: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < cmd.length) {
		// Skip whitespace
		while (i < cmd.length && /\s/.test(cmd[i]!)) i++;
		if (i >= cmd.length) break;

		if (cmd[i] === "'" || cmd[i] === '"') {
			const quote = cmd[i]!;
			i++;
			let token = "";
			while (i < cmd.length && cmd[i] !== quote) {
				if (cmd[i] === "\\" && i + 1 < cmd.length) {
					i++;
				}
				token += cmd[i];
				i++;
			}
			i++; // skip closing quote
			tokens.push(token);
		} else {
			let token = "";
			while (i < cmd.length && !/\s/.test(cmd[i]!)) {
				token += cmd[i];
				i++;
			}
			tokens.push(token);
		}
	}
	return tokens;
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
	const isGitCommit = argv0 === "git" && argv.length >= 2 && argv[1] === "commit";

	// git commit detection: check for --no-verify flag
	if (isGitCommit) {
		if (argv.includes("--no-verify") || argv.includes("-n")) {
			return null; // explicitly allowed by user
		}
		return null; // git commit is handled by the pre-commit gate separately
	}

	// rm detection: check for recursive flag
	if (isRm) {
		const hasRecursive = argv.some(
			(a) => a === "-r" || a === "-R" || a === "-rf" || a === "-Rf" || a === "--recursive",
		);
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
		// Auto-block commit when shazam_verify was not run recently.
		// Uses argv-based detection to avoid false positives.
		const argv = tokenizeCommand(cmd);
		const isGitCommit = argv[0] === "git" && argv.length >= 2 && argv[1] === "commit";
		if (isGitCommit) {
			// Skip if --no-verify or -n flag is present
			if (argv.includes("--no-verify") || argv.includes("-n")) {
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

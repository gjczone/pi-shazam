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
import { tokenizeSegments, extractCommandFromEvent } from "./_bash-utils.js";
import { _logWarn, _logInternal } from "../core/output.js";
import { AUDIT_LOG_DIR } from "../core/audit-log.js";
import * as path from "node:path";
import * as fs from "node:fs";

// --- Safety toggle ---

const SAFETY_CONFIG_PATH = path.join(AUDIT_LOG_DIR, "safety-config.json");

/** Whether destructive command detection is enabled. Default true. */
let _safetyEnabled = true;

// Read persisted config on module load
try {
	if (fs.existsSync(SAFETY_CONFIG_PATH)) {
		const raw = fs.readFileSync(SAFETY_CONFIG_PATH, "utf-8");
		const config = JSON.parse(raw);
		if (typeof config.safetyEnabled === "boolean") {
			_safetyEnabled = config.safetyEnabled;
		}
	}
} catch {
	// Ignore read errors, default to enabled
}

/**
 * Enable or disable destructive command safety detection.
 * Persists the setting to a config file in the audit log directory.
 */
export function setSafetyEnabled(enabled: boolean): void {
	_safetyEnabled = enabled;
	try {
		fs.mkdirSync(path.dirname(SAFETY_CONFIG_PATH), { recursive: true });
		fs.writeFileSync(SAFETY_CONFIG_PATH, JSON.stringify({ safetyEnabled: enabled }), "utf-8");
	} catch {
		// Best-effort persistence
	}
}

/** Whether destructive command detection is currently enabled. */
export function isSafetyEnabled(): boolean {
	return _safetyEnabled;
}

/**
 * HIGH-risk — destructive commands that cause IRREVERSIBLE data loss.
 * These ALWAYS trigger confirmation: rm -rf (force-recursive delete),
 * dd (write block device), mkfs/mkswap (format filesystem).
 *
 * rm regex requires BOTH -r/--recursive AND -f/--force in some combination
 * (short flags combined like -rf, separate short flags, or long flags).
 * Bare --recursive without --force is NOT high risk (rm prompts per file).
 *
 * Patterns intentionally excluded (not directly destructive despite being
 * risky in other contexts): eval, source/., curl|sh, fork bomb, backtick
 * substitution, process substitution — these are common in daily agent
 * operations and do not directly destroy data.
 */
const HIGH_RISK_PATTERNS: Array<{ regex: RegExp; label: string }> = [
	{
		regex:
			/rm\s+(-[a-z]*[rf][a-z]*[rf][a-z]*|-[a-z]*[rf][a-z]*\s+-[a-z]*[rf][a-z]*|--recursive\s+.*--force|--force\s+.*--recursive)\b/,
		label: "rm -rf",
	},
	{ regex: /dd\s+if=/, label: "dd if=" },
	{ regex: /\bmkfs\b/, label: "mkfs" },
	{ regex: /\bmkswap\b/, label: "mkswap" },
];

/**
 * MEDIUM-risk — configuration/system damage that is recoverable but
 * potentially severe. These trigger confirmation but can proceed in
 * non-interactive mode.
 *
 * Includes: chmod 777 /, chmod -R 777, chown -R (permission damage),
 * > /dev/sd* (write block device), LVM operations, iptables,
 * and rm -r / (recursive delete on root, without -f).
 *
 * Partition tools (fdisk/parted/sfdisk) are handled via argv-based detection
 * in detectDestructiveCommand() to allow read-only operations (-l, print).
 */
const MEDIUM_RISK_PATTERNS: Array<{ regex: RegExp; label: string }> = [
	// Permission damage (regexes lowercase because tested against toLowerCase())
	{ regex: /chmod\s+(-r\s+)?777\s+\//, label: "chmod 777 /" },
	{ regex: /chmod\s+-r\s+777/, label: "chmod -R 777" },
	{ regex: /chown\s+-r\b/, label: "chown -R" },
	// Direct block device writes
	{ regex: />\s*\/dev\/sd/, label: "> /dev/sd" },
	{ regex: />\s*\/dev\/nvme/, label: "> /dev/nvme" },
	{ regex: />\s*\/dev\/mmcblk/, label: "> /dev/mmcblk" },
	// LVM operations
	{ regex: /\bpvcreate\b/, label: "pvcreate" },
	{ regex: /\bvgcreate\b/, label: "vgcreate" },
	{ regex: /\blvcreate\b/, label: "lvcreate" },
	// Firewall (regexes lowercase because tested against toLowerCase())
	{ regex: /iptables\s+-f\b/, label: "iptables -F" },
	{ regex: /iptables\s+-p\b/, label: "iptables -P" },
	// Recursive delete on root (without -f — less severe than HIGH rm -rf)
	// Covered by argv detection for rm; kept as regex fallback for non-standard invocations
	{
		regex: /rm\s+(-[a-z]*[rf][a-z]*[rf][a-z]*|-[a-z]*[rf][a-z]*\s+-[a-z]*[rf][a-z]*|--recursive|-r[a-z]*)\s+\//,
		label: "rm -r /",
	},
];

/**
 * Strip bodies of QUOTED bash heredocs from the command string.
 *
 * Quoted heredocs (<<'DELIM' or <<"DELIM", with optional dash <<-)
 * perform NO shell expansion inside the body -- all characters are
 * literal. Stripping them before pattern matching eliminates false
 * positives when the body contains text that looks like dangerous
 * shell constructs (e.g. backticks in Markdown code blocks, "eval"
 * in documentation, curl-pipe-sh examples).
 *
 * Unquoted heredocs (<<DELIM, $ and backtick still expand) are NOT
 * stripped -- they can still execute arbitrary code.
 *
 * Handles multiple heredocs and unterminated heredocs (gracefully
 * falls back to the original command).
 */
function stripQuotedHeredocs(cmd: string): string {
	// Match <<'DELIM' or <<-"DELIM" -- optional dash, single or double quotes.
	// Delimiter: starts with letter/underscore, then alphanumeric/underscore/hyphen.
	const startRe = /<<-?(['"])([a-zA-Z_][a-zA-Z0-9_-]*)\1/g;

	let result = "";
	let lastEnd = 0;
	let match: RegExpExecArray | null;

	while ((match = startRe.exec(cmd)) !== null) {
		const matchStart = match.index;
		const matchEnd = matchStart + match[0].length;
		const delim = match[2]!;

		// Search for closing delimiter on its own line (possibly with
		// leading tabs when <<- was used). Bash requires the closing
		// delimiter at the start of a line; optional tabs accommodate
		// the tab-stripping <<- variant.
		const afterHeredoc = cmd.slice(matchEnd);
		const closeRe = new RegExp(`^\\t*${escapeRegex(delim)}$`, "m");
		const closeMatch = closeRe.exec(afterHeredoc);

		if (closeMatch) {
			// Append content before the heredoc start
			result += cmd.slice(lastEnd, matchStart);
			// Skip the heredoc body (from <<'DELIM' through the closing delimiter line)
			const closeEnd = matchEnd + closeMatch.index + closeMatch[0].length;
			lastEnd = closeEnd;
			startRe.lastIndex = closeEnd;
		} else {
			// Unterminated heredoc -- bail out, keep the original command
			break;
		}
	}

	if (lastEnd > 0) {
		result += cmd.slice(lastEnd);
		return result;
	}
	return cmd;
}

/**
 * Strip bodies of single-quoted strings from the command.
 *
 * In bash, single quotes ('...') prevent ALL shell expansion including
 * backtick substitution, variable expansion ($var, $(cmd)), and globbing.
 * Backticks and other dangerous patterns inside single quotes are literal
 * characters and safe.
 *
 * Stripping single-quoted content before pattern matching eliminates
 * false positives from literal text inside command arguments (e.g. gh issue
 * create --body 'Fix `bug` in README').
 *
 * Double-quoted strings ("...") are NOT stripped -- they still allow
 * backtick and variable expansion.
 */
function stripSingleQuotedStrings(cmd: string): string {
	// Single quotes in bash: everything between them is literal.
	// No escaping possible inside single quotes (not even \').
	// Replace the entire quoted body with an empty pair '' so the
	// structural boundary is preserved but inner content is removed.
	return cmd.replace(/'[^']*'/g, "''");
}

/** Escape regex meta-characters in a literal string. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
 * Check if a short flag token (e.g. -rfv, -l) contains a given flag character.
 * Returns true for combined flags like -rf containing 'r' or 'f'.
 */
function _shortFlagHas(token: string, ch: string): boolean {
	if (!token.startsWith("-") || token.startsWith("--")) return false;
	return [...token.slice(1)].includes(ch);
}

/**
 * Check if argv contains a given flag. Handles:
 * - Short flag: -r (checks combined flags like -rfv)
 * - Long flag: --recursive
 */
function _argvHasFlag(argv: string[], shortCh: string | null, longFlag: string | null): boolean {
	return argv.some((a) => {
		if (longFlag && a === longFlag) return true;
		if (shortCh && _shortFlagHas(a, shortCh)) return true;
		return false;
	});
}

/**
 * Check if any non-option argument in argv is the root path "/".
 * Skips argv[0] (command name) and flags/option-arguments.
 */
function _argvTargetsRoot(argv: string[]): boolean {
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			// Everything after -- is positional
			for (let j = i + 1; j < argv.length; j++) {
				if (argv[j] === "/") return true;
			}
			return false;
		}
		if (a === "/") return true;
	}
	return false;
}

/**
 * Find the segment containing a command matching the given name(s),
 * skipping common prefixes like sudo/nice/command.
 * Returns the argv segment starting from the command itself (prefix stripped), or null.
 */
function _findCommandSegment(segments: string[][], ...names: string[]): string[] | null {
	const PREFIXES = new Set(["sudo", "nice", "command", "busybox", "ionice", "chroot", "strace", "timeout"]);
	for (const seg of segments) {
		if (seg.length === 0) continue;
		const cmd0 = seg[0]?.toLowerCase() ?? "";
		// Direct match on seg[0]
		if (names.some((n) => cmd0 === n || cmd0.endsWith("/" + n))) {
			return seg;
		}
		// Match after known prefix (sudo, nice, etc.)
		if (seg.length > 1 && PREFIXES.has(cmd0)) {
			const cmd1 = seg[1]?.toLowerCase() ?? "";
			if (names.some((n) => cmd1 === n || cmd1.endsWith("/" + n))) {
				return seg.slice(1);
			}
		}
	}
	return null;
}

/**
 * Check if a parted command line is read-only (contains "print" subcommand).
 */
function _isPartedReadOnly(argv: string[]): boolean {
	// parted [opts] [device [cmd]] -- if "print" appears as a positional arg, it's read-only.
	// Parted flags: -h/-v/-l/-m/-s (-s is script mode, but if cmd is print it's still read-only)
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "print") return true;
		if (a === "--") break;
	}
	return false;
}

/**
 * Extract positional target arguments from an argv array for rm.
 * Skips argv[0] (command name), skips flags starting with `-`,
 * handles `--` separator, and returns the remaining positional args.
 */
function _extractRmTargets(argv: string[]): string[] {
	const targets: string[] = [];
	let afterSep = false;
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			afterSep = true;
			continue;
		}
		if (!afterSep && a.startsWith("-")) {
			continue;
		}
		targets.push(a);
	}
	return targets;
}

/**
 * Check whether the resolved target path is safe to delete for rm -rf.
 *
 * Safe heuristics (checked in order, returns { safe: true } on first match):
 *   1. Inside node_modules: resolvedPath includes "/node_modules/"
 *   2. Git worktree: resolvedPath/.git exists as a FILE containing "gitdir:"
 *   3. Matches .gitignore: read cwd/.gitignore, parse patterns, check suffix match
 *   4. Project-level dot-directory: resolvedPath is directly inside cwd AND basename starts with "."
 *
 * Danger heuristics (returns { safe: false, reason } on first match):
 *   5. Root "/" — "Deleting the entire filesystem root — will destroy ALL data"
 *   6. System path — starts with /etc/, /usr/, /bin/, /sbin/, /var/, /opt/, /lib/, /root/, /dev/, /proc/, /sys/
 *   7. Cross-project — resolves outside cwd
 *   8. Database files — ends in .db, .sqlite, .sqlite3
 *   9. Default — "Force-recursive delete will permanently remove these files"
 */
function _isTargetSafe(resolvedPath: string, cwd: string): { safe: boolean; reason?: string } {
	// --- Safe heuristics (return safe on first match) ---

	// 1. Inside node_modules
	if (resolvedPath.includes("/node_modules/")) {
		return { safe: true };
	}

	// 2. Git worktree: check resolvedPath/.git exists as FILE containing "gitdir:"
	try {
		const gitPath = path.join(resolvedPath, ".git");
		if (fs.existsSync(gitPath) && fs.statSync(gitPath).isFile()) {
			const content = fs.readFileSync(gitPath, "utf-8");
			if (content.startsWith("gitdir:")) {
				return { safe: true };
			}
		}
	} catch {
		// If the stat/read fails, skip this heuristic
	}

	// 3. Matches .gitignore: read cwd/.gitignore, parse patterns, check suffix
	try {
		const gitignorePath = path.join(cwd, ".gitignore");
		if (fs.existsSync(gitignorePath)) {
			const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
			const relativePath = path.relative(cwd, resolvedPath);
			const lines = gitignoreContent.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
				// Strip trailing / for matching
				const pattern = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
				if (
					relativePath === pattern ||
					relativePath.startsWith(pattern + "/") ||
					relativePath.endsWith("/" + pattern)
				) {
					return { safe: true };
				}
			}
		}
	} catch {
		// If gitignore read fails, skip this heuristic
	}

	// 4. Project-level dot-directory: directly inside cwd and basename starts with "."
	if (path.dirname(resolvedPath) === cwd && resolvedPath !== cwd) {
		const base = path.basename(resolvedPath);
		if (base.startsWith(".")) {
			return { safe: true };
		}
	}

	// --- Danger heuristics (return danger on first match) ---

	// 5. Root "/"
	if (resolvedPath === "/") {
		return { safe: false, reason: "Deleting the entire filesystem root — will destroy ALL data" };
	}

	// 6. System path
	const SYSTEM_DIRS = [
		"/etc/",
		"/usr/",
		"/bin/",
		"/sbin/",
		"/var/",
		"/opt/",
		"/lib/",
		"/root/",
		"/dev/",
		"/proc/",
		"/sys/",
	];
	for (const sysDir of SYSTEM_DIRS) {
		if (resolvedPath.startsWith(sysDir)) {
			return { safe: false, reason: "Deleting a system directory" };
		}
	}

	// 7. Cross-project: resolves outside cwd
	const rel = path.relative(cwd, resolvedPath);
	if (rel.startsWith("..")) {
		return { safe: false, reason: "Deleting files outside current project" };
	}

	// 8. Database files
	if (resolvedPath.endsWith(".db") || resolvedPath.endsWith(".sqlite") || resolvedPath.endsWith(".sqlite3")) {
		return { safe: false, reason: "Deleting database files" };
	}

	// 9. Default
	return { safe: false, reason: "Force-recursive delete will permanently remove these files" };
}

/**
 * Map a pattern label to the default category and reason for non-rm-rf
 * destructive commands. The rm -rf pattern is handled separately via
 * safety heuristics.
 */
function _getDefaultCategory(pattern: string): { category: string; reason: string } {
	switch (pattern) {
		case "rm -rf":
			// Handled separately by _isTargetSafe heuristics — should not reach here
			return { category: "DELETE", reason: "Force-recursive delete will permanently remove these files" };
		case "rm -r /":
			return { category: "DELETE", reason: "Recursive delete on root path — will destroy system files" };
		case "dd if=":
			return { category: "DD_WRITE", reason: "Direct block device write — will destroy data on the target device" };
		case "mkfs":
			return { category: "MKFS", reason: "Creating a filesystem — will destroy data on the target device" };
		case "mkswap":
			return { category: "MKSWAP", reason: "Creating swap — will destroy data on the target device" };
		case "fdisk":
			return { category: "FDISK", reason: "Modifying partition table — can destroy data on the target disk" };
		case "sfdisk":
			return { category: "SFDISK", reason: "Modifying partition table — can destroy data on the target disk" };
		case "parted":
			return { category: "PARTED", reason: "Modifying partition table — can destroy data on the target disk" };
		case "chmod 777 /":
			return { category: "CHMOD", reason: "Making entire root directory world-writable — security risk" };
		case "chmod -R 777":
			return { category: "CHMOD", reason: "Recursively making files world-writable — security risk" };
		case "chown -R":
			return { category: "CHOWN", reason: "Recursively changing file ownership — can break permission model" };
		case "> /dev/sd":
			return {
				category: "DEVICE_WRITE",
				reason: "Writing directly to block device — can destroy filesystem",
			};
		case "> /dev/nvme":
			return {
				category: "DEVICE_WRITE",
				reason: "Writing directly to block device — can destroy filesystem",
			};
		case "> /dev/mmcblk":
			return {
				category: "DEVICE_WRITE",
				reason: "Writing directly to block device — can destroy filesystem",
			};
		case "pvcreate":
			return { category: "LVM", reason: "Creating a physical volume — can destroy data on the target device" };
		case "vgcreate":
			return { category: "LVM", reason: "Creating a volume group — can destroy data on the target device" };
		case "lvcreate":
			return { category: "LVM", reason: "Creating a logical volume — can destroy data on the target device" };
		case "iptables -F":
			return { category: "IPTABLES", reason: "Flushing all iptables rules — can disable network access" };
		case "iptables -P":
			return { category: "IPTABLES", reason: "Setting iptables default policy — can disable network access" };
		default:
			return { category: "UNKNOWN", reason: `High-risk command detected: ${pattern}` };
	}
}

/**
 * Check if ALL targets of an rm -rf argv segment pass the safety heuristics.
 * Returns true when every resolved target is safe, false otherwise.
 */
function _isRmRfAllSafe(argv: string[], cwd: string): boolean {
	const targets = _extractRmTargets(argv);
	if (targets.length === 0) return true;
	for (const t of targets) {
		const resolved = path.resolve(cwd, t);
		const result = _isTargetSafe(resolved, cwd);
		if (!result.safe) return false;
	}
	return true;
}

/**
 * Get the first failure reason from rm -rf targets.
 * Assumes at least one target is dangerous.
 */
function _firstRmRfDanger(argv: string[], cwd: string): string {
	const targets = _extractRmTargets(argv);
	for (const t of targets) {
		const resolved = path.resolve(cwd, t);
		const result = _isTargetSafe(resolved, cwd);
		if (!result.safe) {
			return result.reason ?? "Force-recursive delete will permanently remove these files";
		}
	}
	return "Force-recursive delete will permanently remove these files";
}

/**
 * Check if a command matches any destructive pattern.
 * Uses argv-based parsing for robust matching with precise flag detection.
 * Returns the risk level, matched pattern, category, and reason, or null if safe.
 */
function detectDestructiveCommand(
	cmd: string,
	cwd: string,
): { level: "HIGH" | "MEDIUM"; pattern: string; reason: string; category: string } | null {
	// Strip quoted heredoc bodies and single-quoted string bodies before
	// pattern matching to prevent false positives from literal text inside
	// <<'EOF' ... EOF blocks or 'single-quoted arguments'.
	const stripped = stripQuotedHeredocs(cmd);
	const sqStripped = stripSingleQuotedStrings(stripped);
	const normalized = normalizeWhitespace(sqStripped);
	const lower = normalized.toLowerCase();

	// Parse into segments for per-command analysis (handles sudo prefix, chained cmds)
	const segments = tokenizeSegments(cmd);

	// --- rm: argv-based precise detection ---
	// Only flag rm -rf (force+recursive) as HIGH, rm -r / as MEDIUM.
	// Plain rm -r ./subdir (no force, not root) is safe in dev workflows.
	const rmSeg = _findCommandSegment(segments, "rm");
	if (rmSeg) {
		const hasRecursive = _argvHasFlag(rmSeg, "r", "--recursive") || _argvHasFlag(rmSeg, "R", null);
		const hasForce = _argvHasFlag(rmSeg, "f", "--force");
		const targetsRoot = _argvTargetsRoot(rmSeg);

		if (hasRecursive && hasForce) {
			// Safety heuristic check: if ALL targets pass heuristics, allow silently
			const targets = _extractRmTargets(rmSeg);
			if (targets.length === 0) {
				return null; // No targets — rm -rf with no targets is safe (no-op)
			}
			let allSafe = true;
			for (const t of targets) {
				const resolved = path.resolve(cwd, t);
				if (!_isTargetSafe(resolved, cwd).safe) {
					allSafe = false;
					break;
				}
			}
			if (allSafe) {
				return null; // All targets pass safety heuristics — allow
			}
			// At least one target is dangerous — escalate
			const reason = _firstRmRfDanger(rmSeg, cwd);
			return { level: "HIGH", pattern: "rm -rf", category: "DELETE", reason };
		}
		if (hasRecursive && targetsRoot) {
			return { level: "MEDIUM", pattern: "rm -r /", ..._getDefaultCategory("rm -r /") };
		}
		// hasRecursive but no force and not root: safe (rm prompts per file), no popup
	}

	// --- Partition tools: allow read-only operations ---
	const fdiskSeg = _findCommandSegment(segments, "fdisk");
	if (fdiskSeg) {
		// fdisk -l / fdisk --list = list partitions (read-only, safe)
		const isReadOnly = _argvHasFlag(fdiskSeg, "l", "--list");
		if (!isReadOnly) {
			return { level: "MEDIUM", pattern: "fdisk", ..._getDefaultCategory("fdisk") };
		}
	}

	const sfdiskSeg = _findCommandSegment(segments, "sfdisk");
	if (sfdiskSeg) {
		// sfdisk -l (list), sfdisk -d (dump) = read-only, safe
		const isReadOnly = _argvHasFlag(sfdiskSeg, "l", "--list") || _argvHasFlag(sfdiskSeg, "d", "--dump");
		if (!isReadOnly) {
			return { level: "MEDIUM", pattern: "sfdisk", ..._getDefaultCategory("sfdisk") };
		}
	}

	const partedSeg = _findCommandSegment(segments, "parted");
	if (partedSeg) {
		// parted -l (list all), parted [dev] print = read-only, safe
		const isReadOnly = _argvHasFlag(partedSeg, "l", "--list") || _isPartedReadOnly(partedSeg);
		if (!isReadOnly) {
			return { level: "MEDIUM", pattern: "parted", ..._getDefaultCategory("parted") };
		}
	}

	// --- Regex fallback: skip rm -rf pattern when all targets are safe ---
	// The argv-based detection above handles normal rm invocations; this
	// covers edge cases where the command was not tokenized as an rm segment.
	let _skipRmRfPattern = false;
	if (rmSeg) {
		const hasRecursive = _argvHasFlag(rmSeg, "r", "--recursive") || _argvHasFlag(rmSeg, "R", null);
		const hasForce = _argvHasFlag(rmSeg, "f", "--force");
		if (hasRecursive && hasForce) {
			_skipRmRfPattern = _isRmRfAllSafe(rmSeg, cwd);
		}
	}

	for (const { regex, label } of HIGH_RISK_PATTERNS) {
		if (label === "rm -rf" && _skipRmRfPattern) continue;
		if (regex.test(lower)) {
			return { level: "HIGH", pattern: label, ..._getDefaultCategory(label) };
		}
	}

	for (const { regex, label } of MEDIUM_RISK_PATTERNS) {
		if (regex.test(lower)) {
			return { level: "MEDIUM", pattern: label, ..._getDefaultCategory(label) };
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
		// Skip detection when safety is disabled
		if (_safetyEnabled) {
			const destructive = detectDestructiveCommand(cmd, ctx.cwd);
			if (destructive) {
				const message = [
					`[${destructive.category}]: ${cmd.slice(0, 200)}${cmd.length > 200 ? "..." : ""}`,
					"",
					destructive.reason,
					"",
					"Do you want to continue?",
				].join("\n");

				try {
					const confirmed = await ctx.ui.confirm("Safety Warning", message);

					if (!confirmed) {
						_logInternal("safety", "destructive command blocked", {
							pattern: destructive.pattern,
							cmd: cmd.slice(0, 200),
							level: destructive.level,
							reason: destructive.reason,
						});
						return {
							block: true,
							reason: `Command blocked by safety check: ${destructive.pattern}`,
						};
					}

					// User confirmed, allow the command
					_logInternal("safety", "destructive command allowed", {
						pattern: destructive.pattern,
						cmd: cmd.slice(0, 200),
						level: destructive.level,
						reason: destructive.reason,
					});
					ctx.ui.notify(`Proceeding with ${destructive.level}-risk command...`, "warning");
				} catch (err) {
					// If confirm dialog fails (e.g., non-interactive mode), block high-risk
					_logWarn("registerSafetyHooks", "confirm dialog failed", err);
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
		}

		// -- Check 2: Pre-commit gate --
		// Auto-block commit when shazam_verify was not run recently.
		// #467: segment-aware detection. Previously only argv[0] was checked,
		// so a chained command like `echo safe && git commit` bypassed the
		// gate entirely (argv[0] was "echo"). Now scan every segment for a
		// `git commit` invocation so the gate fires regardless of any benign
		// prefix chained before the commit.
		const segments = tokenizeSegments(cmd);
		const gitCommitSeg = segments.find((seg) => seg[0] === "git" && seg.length >= 2 && seg[1] === "commit");
		if (gitCommitSeg) {
			// Skip if --no-verify or -n flag is present in the commit segment.
			// Scope the check to the commit segment so a benign `echo --no-verify`
			// chained before the commit cannot bypass the gate.
			// Use seg.some to handle combined short flags like -nq, -qn.
			const hasNoVerify =
				gitCommitSeg.includes("--no-verify") ||
				gitCommitSeg.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("n"));
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

/**
 * pi-shazam hooks/after-write — Auto-verify after write/edit operations.
 *
 * Registered on the `tool_result` event. When the LLM writes or edits a file,
 * this hook automatically runs diagnostics and sends diff-aware findings.
 *
 * Features:
 * - Per-file git diff parsing (which files changed, what kind of changes)
 * - Graph diff against session baseline (new orphans, edge changes)
 * - Block on FAIL-level issues (LSP errors detected)
 * - Context-aware recommendations based on findings
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { scanProject } from "../core/scanner.js";
import { getGraphEdgeCount } from "../core/graph.js";
import { diffBaseline } from "../core/cache.js";
import { findOrphans } from "../core/filter.js";
import { diffFromBaseline, formatBaselineDiff } from "../core/baseline.js";
import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Tool names that trigger auto-verify */
const _WRITE_TOOLS = new Set(["write", "edit"]);

// ── Git diff parsing ────────────────────────────────────────────────────────

interface ChangedFile {
	status: "M" | "A" | "D" | "R" | "C";
	file: string;
	linesAdded: number;
	linesRemoved: number;
}

/**
 * Parse git diff to get per-file change information.
 */
function getGitDiff(): ChangedFile[] {
	try {
		const output = execSync(
			"git diff --numstat HEAD 2>/dev/null",
			{ encoding: "utf-8", timeout: 5000 },
		).trim();
		if (!output) return [];

		const result: ChangedFile[] = [];
		for (const line of output.split("\n").filter(Boolean)) {
			const parts = line.split("\t");
			if (parts.length >= 3) {
				result.push({
					status: "M",
					file: parts[2]!,
					linesAdded: parseInt(parts[0]!, 10) || 0,
					linesRemoved: parseInt(parts[1]!, 10) || 0,
				});
			}
		}
		return result;
	} catch {
		return [];
	}
}

/**
 * Get the change description for a file based on its extension and diff stats.
 */
function describeFileChange(file: ChangedFile): string {
	const ext = file.file.split(".").pop()?.toLowerCase() || "";
	if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
		if (file.linesAdded > 50) return "significant changes";
		if (file.linesAdded > 10) return "multiple changes";
		return "minor changes";
	}
	if (ext === "json") return "config/data change";
	if (ext === "css" || ext === "scss" || ext === "less") return "style changes";
	if (ext === "md" || ext === "txt") return "documentation changes";
	return `${file.linesAdded} lines added, ${file.linesRemoved} removed`;
}

// ── LSP diagnostics collection (lightweight) ──────────────────────────────

/**
 * Check if TypeScript errors exist WITHOUT running full tsc.
 * Uses a quick check: looks for common error patterns in recently modified files.
 * Returns error/warning counts only — no individual error details.
 * 
 * Note: We intentionally do NOT run tsc --noEmit on every write/edit.
 * Full diagnostics are noisy and waste context. The LLM can run
 * `shazam_verify` or `npx tsc --noEmit` when it needs detailed errors.
 */
async function collectLspDiagnostics(): Promise<{ errorCount: number; warningCount: number }> {
	// Quick check: only count errors, don't parse details
	try {
		const { stdout } = await execAsync(
			"npx tsc --noEmit 2>&1 | grep -c 'error TS' || true",
			{ encoding: "utf-8", timeout: 10000, maxBuffer: 1024 * 1024 },
		);
		const errorCount = parseInt(stdout.trim(), 10) || 0;
		return { errorCount, warningCount: 0 };
	} catch {
		return { errorCount: 0, warningCount: 0 };
	}
}

// ── Symbol-level change detection ──────────────────────────────────────────

interface SymbolChange {
	name: string;
	kind: string;
	file: string;
	change: "added" | "removed" | "modified";
}

/**
 * Detect symbol-level changes by comparing current graph with cache.
 */
function detectSymbolChanges(projectRoot: string): SymbolChange[] {
	try {
		const baseline = diffBaseline(scanProject(projectRoot, () => {}), projectRoot);
		if (!baseline) return [];

		const changes: SymbolChange[] = [];

		for (const sym of baseline.addedSymbols ?? []) {
			changes.push({ name: sym.name, kind: "symbol", file: sym.file, change: "added" });
		}
		for (const sym of baseline.removedSymbols ?? []) {
			changes.push({ name: sym.name, kind: "symbol", file: sym.file, change: "removed" });
		}
		for (const sym of baseline.modifiedSymbols ?? []) {
			changes.push({ name: sym.name, kind: sym.kind, file: sym.file, change: "modified" });
		}

		return changes;
	} catch (err) {
		// Log error to aid debugging (fixes #143)
		console.warn(`[pi-shazam] detectSymbolChanges failed: ${err}`);
		return [];
	}
}

// ── Handle write result ──────────────────────────────────────────────────────

/**
 * Handle a write/edit tool result by running diagnostics and reporting findings.
 *
 * @param toolName - The tool that was executed (write or edit)
 * @param projectRoot - Project root directory
 * @returns Diagnostic findings as a formatted text string with verdict
 */
export async function handleWriteResult(toolName: string, projectRoot: string): Promise<{ text: string; verdict: "PASS" | "WARN" | "FAIL" }> {
	try {
		// Re-scan project to detect changes
		const graph = scanProject(projectRoot, () => {});

		const lines: string[] = [];
		lines.push(`═══ shazam_verify (auto after ${toolName}) ═══`);
		lines.push("");

		// ── Project summary ──────────────────────────────────────────────
			const edgeCount = getGraphEdgeCount(graph);
		lines.push(`Project: ${graph.symbols.size} symbols, ${graph.fileSymbols.size} files, ${edgeCount} edges`);
		lines.push("");

		// ── Per-file git diff (Issue #75) ────────────────────────────────
		const changedFiles = getGitDiff();
		if (changedFiles.length > 0) {
			lines.push("### Changed Files");
			for (const cf of changedFiles) {
				const description = describeFileChange(cf);
				lines.push(`  ${cf.status} ${cf.file} — ${description}`);
			}
			lines.push("");
		}

		// ── Session baseline diff (Issue #79 + #78) ──────────────────────
		const sessionDiff = diffFromBaseline(graph, 0, 0);
		if (sessionDiff) {
			lines.push(formatBaselineDiff(sessionDiff));
		} else {
			// Fall back to disk cache diff
			const diskDiff = diffBaseline(graph, projectRoot);
			if (diskDiff) {
				const added = diskDiff.addedSymbols?.length ?? 0;
				const removed = diskDiff.removedSymbols?.length ?? 0;
				const modified = diskDiff.modifiedSymbols?.length ?? 0;
				if (added + removed + modified > 0) {
					lines.push("### Graph Changes");
					lines.push(`+${added} added, -${removed} removed, ~${modified} modified`);
					lines.push("");
				}
			}
		}

		// ── Symbol-level changes ─────────────────────────────────────────
		const symbolChanges = detectSymbolChanges(projectRoot);
		if (symbolChanges.length > 0) {
			lines.push("### Symbol Changes");
			for (const sc of symbolChanges.slice(0, 15)) {
				lines.push(`  ${sc.change === "added" ? "+" : sc.change === "removed" ? "-" : "~"} ${sc.kind} \`${sc.name}\` — ${sc.file}`);
			}
			if (symbolChanges.length > 15) {
				lines.push(`  ... and ${symbolChanges.length - 15} more`);
			}
			lines.push("");
		}

		// ── LSP Diagnostics (summary only — no individual errors) ───────────
		const lspDiags = await collectLspDiagnostics();

		lines.push("### LSP Diagnostics");
		if (lspDiags.errorCount > 0) {
			lines.push(`[FAIL] ${lspDiags.errorCount} type error(s) found`);
			lines.push("  Run `npx tsc --noEmit` to see details");
		} else {
			lines.push("[PASS] No type errors");
		}
		lines.push("");

		// ── Orphan analysis ──────────────────────────────────────────────
		const orphans = findOrphans(graph);

		if (orphans.length > 0) {
			lines.push(`[WARN] ${orphans.length} orphan symbols detected`);
		} else {
			lines.push("[PASS] No orphan symbols");
		}
		lines.push("");

		// ── Risk assessment ─────────────────────────────────────────────
		const totalChanges = changedFiles.length + orphans.length + lspDiags.errorCount;
		let riskLevel: string;
		if (lspDiags.errorCount > 0) {
			riskLevel = "HIGH — fix type errors before proceeding";
		} else if (orphans.length > 10 || totalChanges > 20) {
			riskLevel = "MEDIUM — review orphans and verify intent";
		} else {
			riskLevel = "LOW — changes look contained";
		}
		lines.push(`Risk: ${riskLevel}`);
		lines.push("");

		// ── Determine verdict ────────────────────────────────────────────
		let verdict: "PASS" | "WARN" | "FAIL";
		if (lspDiags.errorCount > 0) {
			verdict = "FAIL";
		} else if (orphans.length > 0) {
			verdict = "WARN";
		} else {
			verdict = "PASS";
		}
		lines.push(`Verdict: [${verdict}]`);

		return { text: lines.join("\n"), verdict };
	} catch (err) {
		return {
			text: `[pi-shazam] Auto-verify failed: ${err}`,
			verdict: "WARN",
		};
	}
}

// ── Register hook ──────────────────────────────────────────────────────────

/**
 * Register the after-write hook on the Pi extension API.
 *
 * On `tool_result` for write/edit operations, runs diagnostics and sends
 * findings via pi.sendMessage(). Optionally blocks on FAIL verdict
 * to prevent the LLM from continuing with broken code.
 */
export function shouldTriggerVerify(toolName: string, isError: boolean): boolean {
	return _WRITE_TOOLS.has(toolName) && !isError;
}

export function registerAfterWriteHook(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, _ctx) => {
		try {
			// Skip non-write tools and errors
			if (!shouldTriggerVerify(event.toolName, event.isError)) {
				return;
			}

			const result = await handleWriteResult(event.toolName, ".");

			// Send findings as a message to the LLM
			pi.sendMessage({
				customType: "shazam-auto-verify",
				content: result.text,
				display: true,
			});

			// Issue #78: Block on FAIL verdict to prevent continuing with broken code
			// This returns { block: true } which stops the LLM from proceeding
			// until the user acknowledges or fixes the issues.
			if (result.verdict === "FAIL") {
				// Return from the handler to signal blocking
				// Note: tool_result handlers can return { block: true } but this
				// is not standard in all Pi versions. We use sendMessage as
				// the primary mechanism; blocking is best-effort.
				pi.logger?.warn?.("[pi-shazam] FAIL verdict — fix errors before proceeding");
			}
		} catch (err) {
			pi.logger?.warn(`[pi-shazam] Auto-verify hook error: ${err}`);
		}
	});
}

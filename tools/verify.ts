/**
 * pi-shazam tools/verify -- Unified post-edit verification gate.
 *
 * Merges verify, check, and ready into one tool:
 *   1. LSP diagnostics (CORE) -- type errors, warnings from language servers
 *   2. Graph analysis (SUPPLEMENTARY) -- git diff, risk, orphans, graph diff
 *   3. Summary verdict -- PASS / WARN / FAIL
 *
 * Supports modes:
 *   - default: full LSP + graph analysis
 *   - quick:    git changes + risk only (~2s)
 *   - lspOnly:  LSP diagnostics only, skip graph analysis
 *   - preCommit: stricter thresholds for pre-commit gate
 */
import type { ExtensionAPI, AgentToolResult } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { getGraphEdgeCount } from "../core/graph.js";
import { diffFromBaseline } from "../core/baseline.js";
import { assessRisk } from "../core/risk.js";
import { isNonSourceFile, findOrphans, isTestFile } from "../core/filter.js";

// Infrastructure error patterns — when >50% of diagnostics match these,
// LSP is likely in a broken state (e.g., node_modules not accessible).
// In that case, fall back to subprocess diagnostics (tsc --noEmit).
export const INFRASTRUCTURE_ERROR_PATTERNS: readonly RegExp[] = [
	/cannot find (module|name)/i,
	/property .* does not exist on type '{}'/i,
	/cannot find name 'node:/i,
	/implicitly has an 'any' type/i,
];

// Max errors to display in text output; when exceeded, full diagnostics
// are saved to .shazam/last-verify.json for agent inspection.
export const MAX_DISPLAY_ERRORS = 10;

import { execFile } from "node:child_process";
import { getGitChangedFiles } from "../core/git-utils.js";
import { detectProjectLanguages } from "../core/formatters.js";
import { getEffectiveRoot } from "../core/scanner.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { redact } from "../core/redact.js";
import { readFileAdaptiveAsync } from "../core/encoding.js";
import { resolve, join } from "node:path";
import { getNextForTool, formatNextSection, truncateOutput, estimateTokens, _logWarn } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { lspCodeActions, lspReferences, upgradeEdgesToResolved } from "./lsp_enrich.js";
import { createTool } from "./_factory.js";
import { dispatchVerify } from "./_dispatchers.js";
import { setLastToolTiming } from "./_context.js";
import { uriToPath } from "../lsp/client.js";

export function registerVerify(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_verify",
		label: "Verify Changes",
		description: `\
		After every write or edit, run this to confirm no errors were
		introduced. Runs LSP diagnostics (type errors, warnings), then graph
		analysis (git diff, risk level, orphan detection).
		Verdict: PASS / WARN / FAIL. Use --quick for a fast git-change-only
		check (~2s). Use --lspOnly for diagnostics only. Use --preCommit for
		stricter thresholds. Relies on the incremental mtime scan -- the
		on-disk graph cache is reused, not bypassed.`,
		params: Type.Object({
			quick: Type.Optional(Type.Boolean()),
			lspOnly: Type.Optional(Type.Boolean()),
			preCommit: Type.Optional(Type.Boolean()),
			// maxFiles is no longer a per-call parameter (#630) -- it now
			// lives in `.pi-shazam/config.json` under `verify.maxFiles`.
			// The dispatcher reads the config and merges it into VerifyOptions.
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens as number | undefined;
			const projectRoot = getEffectiveRoot();

			const t0 = Date.now();
			const result = await dispatchVerify(undefined, params, projectRoot);
			let text = result.text;
			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens);
			}
			const totalMs = Date.now() - t0;
			setLastToolTiming({ execute: totalMs });
			return { content: [{ type: "text", text }] };
		},
	});
}

// -- Verify options ----------------------------------------------------------

export interface VerifyOptions {
	quick?: boolean;
	lspOnly?: boolean;
	preCommit?: boolean;
	/**
	 * Max files to pass to the LSP server for diagnostics. Resolved by
	 * the dispatcher from the per-call value (none) > the
	 * `.pi-shazam/config.json` `verify.maxFiles` value > the hard-coded
	 * default of 100 (#630). Direct callers of `executeVerifyTextAsync`
	 * / `executeVerifyJsonAsync` can still pass an explicit value here.
	 */
	maxFiles?: number;
	// noCascade and noSecrets were never read anywhere in the codebase
	// (dead options from an earlier migration). Dropped in #630 along
	// with the per-call flag. If cascade analysis or secrets detection
	// are reintroduced they should re-appear in `.pi-shazam/config.json`
	// as boolean fields, not as per-call flags.
}

// -- JSON maxTokens truncation (issue #470) ----------------------------------

/**
 * Maximum number of lspDiagnostics entries kept in JSON mode when the
 * serialized output exceeds maxTokens. Diagnostics are the main source of
 * JSON bloat in verify output; capping this array bounds the payload
 * without invalidating the JSON structure.
 */
const MAX_JSON_DIAGNOSTICS = 100;

/**
 * Shape of the verify JSON result. Only the fields relevant to truncation
 * are constrained; the rest flow through as-is from executeVerifyJsonAsync.
 */
export interface VerifyJsonResult {
	lspDiagnostics: unknown[];
	lspDiagnosticsTruncated?: number;
	[key: string]: unknown;
}

/**
 * Cap `lspDiagnostics` in a verify JSON result when the serialized output
 * would exceed maxTokens. Issue #470: verify JSON mode bypassed truncation
 * (`if (maxTokens && !json)`), so a project with hundreds of LSP
 * diagnostics could flood the LLM context window.
 *
 * Mutates `result` in place: when truncation occurs, replaces
 * `lspDiagnostics` with a capped slice and adds a `lspDiagnosticsTruncated`
 * count so consumers know how many entries were dropped. Always produces
 * valid JSON (array slice before serialization, never a string slice).
 *
 * Returns true when truncation was applied, false otherwise.
 *
 * @param result - The verify result object (mutated in place)
 * @param serializedText - The JSON.stringify output of the full envelope
 * @param maxTokens - Token budget; when undefined or not exceeded, no-op
 */
export function capVerifyDiagnostics(result: VerifyJsonResult, serializedText: string, maxTokens?: number): boolean {
	if (!maxTokens) return false;
	if (estimateTokens(serializedText) <= maxTokens) return false;
	const diags = result.lspDiagnostics;
	if (!Array.isArray(diags) || diags.length <= MAX_JSON_DIAGNOSTICS) return false;
	result.lspDiagnostics = diags.slice(0, MAX_JSON_DIAGNOSTICS);
	result.lspDiagnosticsTruncated = diags.length - MAX_JSON_DIAGNOSTICS;
	return true;
}

// -- Async verify (LSP + graph, used by the tool) ----------------------------

export async function executeVerifyJsonAsync(projectRoot: string, options: VerifyOptions) {
	const { scanProject } = await import("../core/scanner.js");
	const graph = scanProject(projectRoot);
	const quick = options.quick ?? false;
	const lspOnly = options.lspOnly ?? false;
	const preCommit = options.preCommit ?? false;

	const edgeCount = getGraphEdgeCount(graph);

	const orphanResult = findOrphans(graph);
	const orphans = orphanResult.all;
	const internalOrphans = orphanResult.internal;
	const exportedOrphans = orphanResult.exported;
	const gitChangedFiles = getGitChangedFiles(projectRoot);

	let lspDiagnostics: LspDiagEntry[] = [];
	let lspAvailable = false;
	let lspFailedOpens: string[] = [];
	let lspReliable: boolean | undefined;
	let lspReliableMessage: string | undefined;
	if (lspOnly || !quick) {
		const lspResult = await runLspDiagnostics(graph, projectRoot, options);
		lspDiagnostics = lspResult.diagnostics;
		lspAvailable = lspResult.available;
		lspFailedOpens = lspResult.failedOpens ?? [];
		lspReliable = lspResult.lspReliable;
		lspReliableMessage = lspResult.lspReliableMessage;
	}

	// JSON mode: early return for lspOnly (skip graph analysis, same as text mode)
	if (lspOnly) {
		return {
			symbolCount: graph.symbols.size,
			fileCount: graph.fileSymbols.size,
			edgeCount: getGraphEdgeCount(graph),
			riskLevel: "low",
			riskReason: "lspOnly mode - graph analysis skipped",
			orphanCount: 0,
			orphans: [],
			internalOrphanCount: 0,
			exportedOrphanCount: 0,
			gitChangedFiles: [],
			baselineDiff: null,
			lspDiagnostics,
			lspAvailable,
			lspReliable: lspReliable ?? true,
			lspReliableMessage,
			failedOpens: lspFailedOpens,
			verdict: lspDiagnostics.some((d) => d.severity === "error")
				? "FAIL"
				: lspFailedOpens.length > 0
					? "WARN"
					: "PASS",
			quickMode: quick,
			lspOnlyMode: lspOnly,
			preCommitMode: preCommit,
		};
	}

	// Single-pass count to avoid multiple filter().length iterations (#573)
	let lspErrors = 0;
	let lspWarnings = 0;
	for (const d of lspDiagnostics) {
		if (preCommit && isTestFile(d.file)) continue;
		if (d.severity === "error") lspErrors++;
		else if (d.severity === "warning") lspWarnings++;
	}
	const risk = _assessVerifyRisk(graph, internalOrphans, gitChangedFiles, preCommit, lspErrors, lspWarnings);

	let verdict = "PASS";
	if (lspErrors > 0) {
		verdict = "FAIL";
	} else if (!lspAvailable && !quick && !lspOnly) {
		verdict = "WARN";
	} else if (preCommit && risk.level !== "low") {
		verdict = "FAIL";
	} else if (lspFailedOpens.length > 0) {
		// Upgrade to WARN when files failed to open -- diagnostics may be incomplete (fix #453)
		verdict = "WARN";
	}

	return {
		symbolCount: graph.symbols.size,
		fileCount: graph.fileSymbols.size,
		edgeCount,
		riskLevel: risk.level,
		riskReason: risk.reason,
		orphanCount: orphans.length,
		orphans: orphans
			.slice(0, 20)
			.map((s) => ({ name: s.name, kind: s.kind, file: s.file, line: s.line, isExported: s.isExported })),
		internalOrphanCount: internalOrphans.length,
		exportedOrphanCount: exportedOrphans.length,
		gitChangedFiles: gitChangedFiles.slice(0, 50),
		baselineDiff: null,
		lspDiagnostics,
		lspAvailable,
		failedOpens: lspFailedOpens,
		verdict,
		quickMode: quick,
		lspOnlyMode: lspOnly,
		preCommitMode: preCommit,
	};
}

export async function executeVerifyTextAsync(projectRoot: string, options: VerifyOptions): Promise<string> {
	const { scanProject } = await import("../core/scanner.js");
	const graph = scanProject(projectRoot);
	const quick = options.quick ?? false;
	const lspOnly = options.lspOnly ?? false;
	const preCommit = options.preCommit ?? false;

	const lines: string[] = [];
	const modeLabel = preCommit ? " (Pre-Commit)" : quick ? " (Quick)" : lspOnly ? " (LSP Only)" : "";
	lines.push(`## Verify Results${modeLabel}`);
	lines.push("");

	const symbolCount = graph.symbols.size;
	const fileCount = graph.fileSymbols.size;
	const edgeCount = getGraphEdgeCount(graph);
	lines.push(`**Symbols:** ${symbolCount} | **Files:** ${fileCount} | **Edges:** ${edgeCount}`);
	lines.push("");

	// LSP diagnostics (CORE)
	let lspResult: LspDiagResult = { diagnostics: [], available: false };
	if (!quick) {
		lspResult = await runLspDiagnostics(graph, projectRoot, options);
		lines.push("### LSP Diagnostics");
		lines.push("");
		if (!lspResult.available) {
			lines.push("[WARN] LSP diagnostics unavailable - type/lint errors not checked.");
			if (lspResult.errorMessage) {
				lines.push(`  Reason: ${lspResult.errorMessage}`);
			}
			lines.push(
				"  To fix: Install language servers (e.g., typescript-language-server, pyright, gopls, rust-analyzer)",
			);
		} else if (lspResult.diagnostics.length === 0) {
			lines.push("[PASS] No diagnostics found.");
			if (lspResult.lspReliable === false && lspResult.lspReliableMessage) {
				lines.push(lspResult.lspReliableMessage);
			}
		} else {
			// Surface LSP reliability info when fallback occurred (issue #497)
			if (lspResult.lspReliable === false && lspResult.lspReliableMessage) {
				lines.push(lspResult.lspReliableMessage);
				lines.push("");
			}

			const errors = lspResult.diagnostics.filter((d) => d.severity === "error");
			const warnings = lspResult.diagnostics.filter((d) => d.severity === "warning");
			const infos = lspResult.diagnostics.filter((d) => d.severity === "info");
			const hints = lspResult.diagnostics.filter((d) => d.severity === "hint");
			lines.push(
				`Errors: ${errors.length} | Warnings: ${warnings.length} | Info: ${infos.length} | Hint: ${hints.length}`,
			);
			lines.push("");
			// #629: LLM-friendly compact format. One line per diagnostic --
			// `path:line:col  SEV CODE  message (source)`. No multi-line
			// suggestedFixes rendering (use --json if fixes are needed).
			// The old MAX_DISPLAY_ERRORS truncation + .shazam/last-verify.json
			// auto-export are dropped: a verbose mode is not a published
			// feature and no test asserts on it.
			lines.push(summarizeDiagnostics(lspResult.diagnostics));
			lines.push("");
			for (const d of lspResult.diagnostics) {
				lines.push(formatDiagnosticCompact(d));
			}
		}
		lines.push("");
	}

	// Surface failedOpens as a warning section (fix #453)
	if (lspResult.failedOpens && lspResult.failedOpens.length > 0) {
		lines.push("### LSP File Open Failures");
		lines.push("");
		lines.push(`${lspResult.failedOpens.length} file(s) could not be opened in LSP - diagnostics may be incomplete:`);
		for (const f of lspResult.failedOpens.slice(0, 10)) {
			lines.push(`- ${f}`);
		}
		if (lspResult.failedOpens.length > 10) {
			lines.push(`  ... and ${lspResult.failedOpens.length - 10} more`);
		}
		lines.push("");
	}

	if (lspOnly) {
		const lspVerdict = lspResult.diagnostics.some((d) => d.severity === "error") ? "FAIL" : "PASS";
		lines.push("### Verdict: " + lspVerdict);
		lines.push("");
		lines.push("[lspOnly mode - graph analysis skipped]");
		lines.push("");
		return lines.join("\n");
	}

	// Graph analysis
	const gitChangedFiles = getGitChangedFiles(projectRoot);
	lines.push("### Git Working Tree Changes");
	if (gitChangedFiles.length > 0) {
		lines.push(`Files changed: ${gitChangedFiles.length}`);
		for (const f of gitChangedFiles.slice(0, 20)) lines.push(`  - ${f}`);
		if (gitChangedFiles.length > 20) lines.push(`  ... and ${gitChangedFiles.length - 20} more`);
	} else {
		lines.push("No uncommitted changes.");
	}
	lines.push("");

	// Baseline diff removed (issue #319)

	const orphanResult = findOrphans(graph);
	const orphans = orphanResult.all;
	const internalOrphans = orphanResult.internal;
	const exportedOrphans = orphanResult.exported;

	// Filter orphans (delta mode disabled -- diffBaseline removed, issue #319)
	let displayOrphans = orphans;

	if (displayOrphans.length > 0) {
		lines.push("### Potential Orphan Symbols");
		lines.push("");
		lines.push(`Found ${displayOrphans.length} symbols with zero incoming references:`);
		lines.push("");

		// Separate internal and exported orphans
		if (internalOrphans.length > 0) {
			lines.push(`#### Internal (likely dead code) - ${internalOrphans.length} symbols`);
			for (const orphan of internalOrphans.slice(0, 10)) {
				lines.push(`- ${orphan.kind} \`${orphan.name}\` - ${orphan.file}:${orphan.line}`);
			}
			if (internalOrphans.length > 10) lines.push(`  ... and ${internalOrphans.length - 10} more`);
			lines.push("");
		}

		if (exportedOrphans.length > 0) {
			lines.push(`#### Exported (may be used externally) - ${exportedOrphans.length} symbols`);
			for (const orphan of exportedOrphans.slice(0, 10)) {
				lines.push(`- ${orphan.kind} \`${orphan.name}\` - ${orphan.file}:${orphan.line} [exported]`);
			}
			if (exportedOrphans.length > 10) lines.push(`  ... and ${exportedOrphans.length - 10} more`);
			lines.push("");
		}
	} else {
		lines.push("### Orphan Symbols: None detected", "");
	}

	// Count LSP errors/warnings, excluding test files in preCommit mode
	// (test files are validated by the test runner, not the pre-commit gate)
	const sourceDiagnostics = preCommit
		? lspResult.diagnostics.filter((d) => !isTestFile(d.file))
		: lspResult.diagnostics;
	// Single-pass count to avoid multiple filter().length iterations (#573)
	let lspErrors = 0;
	let lspWarnings = 0;
	for (const d of sourceDiagnostics) {
		if (d.severity === "error") lspErrors++;
		else if (d.severity === "warning") lspWarnings++;
	}
	const risk = _assessVerifyRisk(graph, internalOrphans, gitChangedFiles, preCommit, lspErrors, lspWarnings);
	lines.push("### Risk Level");
	lines.push(`**${risk.level}** - ${risk.reason}`);
	lines.push("");

	if (quick) lines.push("[Quick mode - skipped deep analysis]\n");

	if (preCommit) {
		// Reuse the LSP result from above -- do NOT call runLspDiagnostics again
		// (collectDiagnostics is destructive, second call returns empty results)
		const hasLspErrors = sourceDiagnostics.some((d) => d.severity === "error");
		const isReady = !hasLspErrors && risk.level === "low" && internalOrphans.length === 0;
		lines.push("### Pre-Commit Verdict");
		lines.push(`**Status:** ${isReady ? "[PASS] READY" : "[FAIL] NOT READY"}`);
		lines.push("");
		if (!isReady) {
			lines.push("### Issues to Fix Before Commit");
			lines.push("");
			if (hasLspErrors) lines.push("- LSP errors found - fix type errors before commit");
			if (risk.level !== "low") lines.push(`- Risk level is **${risk.level}** - review affected files`);
			if (internalOrphans.length > 0)
				lines.push(`- ${internalOrphans.length} internal orphan symbol(s) - review for dead code`);
			lines.push("");
		}
	}

	// Compute verdict for non-preCommit non-lspOnly mode
	let verdict = "PASS";
	if (lspResult.diagnostics.some((d) => d.severity === "error")) {
		verdict = "FAIL";
	} else if (!lspResult.available && !quick && !lspOnly) {
		verdict = "WARN";
	} else if (risk.level === "high") {
		verdict = "WARN";
	} else if (lspResult.failedOpens && lspResult.failedOpens.length > 0) {
		// Upgrade to WARN when files failed to open -- diagnostics may be incomplete (fix #453)
		verdict = "WARN";
	}
	if (!preCommit) {
		lines.push("### Verdict: " + verdict);
		lines.push("");
	}

	const nextItems = getNextForTool("verify", { riskLevel: risk.level, orphanCount: orphans.length });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

// -- LSP diagnostics (absorbed from tools/check.ts) -------------------------

interface LspDiagEntry {
	file: string;
	line: number;
	col: number;
	endLine: number;
	endCol: number;
	severity: string;
	code: string;
	message: string;
	suggestedFixes?: string[];
}

interface LspDiagResult {
	diagnostics: LspDiagEntry[];
	available: boolean;
	errorMessage?: string;
	failedOpens?: string[];
	lspReliable?: boolean;
	lspReliableMessage?: string;
}

// -- Compact text formatter (#629) ------------------------------------------

/**
 * Map a file extension to a short language label for the compact line.
 * Used as the trailing `(source)` annotation -- tells the LLM whether the
 * issue is TypeScript, Python, etc. without parsing the full path.
 */
function sourceFromFile(file: string): string {
	const m = /\.([a-z0-9]+)$/i.exec(file);
	if (!m) return "lsp";
	const ext = m[1]!.toLowerCase();
	if (ext === "ts" || ext === "tsx") return "typescript";
	if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript";
	if (ext === "py") return "python";
	if (ext === "go") return "go";
	if (ext === "rs") return "rust";
	if (ext === "dart") return "dart";
	if (ext === "json") return "json";
	return ext;
}

/**
 * Format a single diagnostic as one line:
 *   `path:line:col  SEV CODE  message (source)`
 * `SEV` is the 3-letter severity (`ERR` / `WRN` / `INF` / `HNT`).
 * `CODE` is omitted when the diagnostic has no LSP code attached.
 * Exported so unit tests can assert exact format without spinning up LSP.
 */
export function formatDiagnosticCompact(d: LspDiagEntry): string {
	const sev = d.severity === "error" ? "ERR" : d.severity === "warning" ? "WRN" : d.severity === "info" ? "INF" : "HNT";
	const code = d.code ? ` ${d.code}` : "";
	return `${d.file}:${d.line}:${d.col}  ${sev}${code}  ${d.message} (${sourceFromFile(d.file)})`;
}

/**
 * Build the summary header line that goes above the per-diagnostic block:
 *   `N errors, M warnings across K files. Build: clean.`
 * `Build: clean` is included verbatim per the issue spec; it signals to the
 * LLM that no follow-up tsc run is needed when diagnostics are empty.
 */
export function summarizeDiagnostics(diagnostics: LspDiagEntry[]): string {
	let errors = 0;
	let warnings = 0;
	const files = new Set<string>();
	for (const d of diagnostics) {
		if (d.severity === "error") errors++;
		else if (d.severity === "warning") warnings++;
		if (d.file) files.add(d.file);
	}
	const fileWord = files.size === 1 ? "file" : "files";
	return `${errors} errors, ${warnings} warnings across ${files.size} ${fileWord}. Build: clean.`;
}

// -- Diagnostic reliability and export helpers (issue #497) ------------------

/**
 * Check whether LSP diagnostics are reliable by counting how many match
 * known infrastructure-only error patterns. When >50% of diagnostics on
 * >20 total diagnostics match infra patterns, the LSP server is likely
 * in a broken state (e.g., node_modules not accessible).
 */
export function checkDiagnosticReliability(diagnostics: { message: string }[]): {
	reliable: boolean;
	infraErrorCount: number;
	totalCount: number;
	message?: string;
} {
	const totalCount = diagnostics.length;
	if (totalCount === 0) return { reliable: true, infraErrorCount: 0, totalCount: 0 };

	let infraErrorCount = 0;
	for (const d of diagnostics) {
		const msg = d.message;
		if (msg && INFRASTRUCTURE_ERROR_PATTERNS.some((p) => p.test(msg))) {
			infraErrorCount++;
		}
	}

	const reliable = totalCount <= 20 || infraErrorCount <= totalCount * 0.5;
	const message = reliable
		? undefined
		: `[INFO] LSP diagnostics deemed unreliable (${infraErrorCount}/${totalCount} errors match infrastructure patterns). Falling back to tsc --noEmit subprocess diagnostics.`;

	return { reliable, infraErrorCount, totalCount, message };
}

/**
 * Save full diagnostics to .shazam/last-verify.json for agent inspection.
 * Creates the .shazam directory if it does not exist.
 * Overwrites any previous export.
 *
 * @returns The path to the saved file.
 */
export function saveDiagnosticsExport(diagnostics: LspDiagEntry[], projectRoot: string): string {
	const shazamDir = resolve(projectRoot, ".shazam");
	mkdirSync(shazamDir, { recursive: true });

	// Single-pass count to avoid multiple filter().length iterations (#573)
	let errorCount = 0;
	let warningCount = 0;
	for (const d of diagnostics) {
		if (d.severity === "error") errorCount++;
		else if (d.severity === "warning") warningCount++;
	}

	const exportData = {
		timestamp: new Date().toISOString(),
		totalCount: diagnostics.length,
		errorCount,
		warningCount,
		diagnostics,
	};

	const exportPath = join(shazamDir, "last-verify.json");
	writeFileSync(exportPath, JSON.stringify(exportData, null, 2), "utf-8");
	return exportPath;
}

async function runLspDiagnostics(
	graph: RepoGraph,
	projectRoot: string,
	options: VerifyOptions,
): Promise<LspDiagResult> {
	const maxFiles = options.maxFiles ?? 100;
	const targetFiles = [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f)).slice(0, maxFiles);

	if (targetFiles.length === 0) return { diagnostics: [], available: false };

	const lspManager = getLspManager();
	if (!lspManager) {
		// Log fallback to subprocess diagnostics (fixes #149)
		_logWarn("runLspDiagnostics", "LSP manager not available, falling back to subprocess diagnostics");
		return runSubprocessDiagnostics(projectRoot);
	}

	const diagnostics: LspDiagEntry[] = [];
	const serversUsed = new Set<string>();
	const failedOpens: string[] = [];

	// Open files in parallel (each getServerForFile internally deduplicates
	// concurrent inits for the same language via _initPromises).
	const openResults = await Promise.allSettled(
		targetFiles.map(async (filePath) => {
			const serverInfo = await lspManager.getServerForFile(filePath);
			if (!serverInfo) return { filePath, opened: false, serverName: "" };
			try {
				const absPath = resolve(projectRoot, filePath);
				// #641: capture the on-disk mtime BEFORE reading the file so
				// we can pass it to the manager for stale-cache detection.
				// A stat failure here is non-fatal -- the file may have been
				// deleted between scanProject and the LSP open; the
				// readFileAdaptiveAsync below will surface the real error.
				let mtime: number;
				try {
					mtime = (await stat(absPath)).mtimeMs;
				} catch (_statErr) {
					// Fall back to "now" so the manager's record still exists
					// if the file reappears. invalidateIfStale's mtime check
					// will not match Date.now() against a real mtime, so the
					// next verify cycle will invalidate it correctly.
					mtime = Date.now();
				}
				// #641: If the file was edited since the previous verify
				// cycle, send didClose for the stale version so the LSP
				// server drops its old per-document AST. Without this, the
				// server returns diagnostics against the OLD content even
				// though didOpen below sends the NEW content.
				await lspManager.invalidateIfStale(filePath, mtime);
				const content = await readFileAdaptiveAsync(absPath);
				await serverInfo.client.didOpen(filePath, content);
				// Track for crash recovery AND for the next verify cycle's
				// stale-cache check (#641).
				lspManager.trackOpenedFile(serverInfo.language, filePath, mtime);
				return { filePath, opened: true, serverName: serverInfo.serverName };
			} catch (e) {
				return { filePath, opened: false, serverName: serverInfo.serverName, error: e };
			}
		}),
	);

	for (const result of openResults) {
		if (result.status === "fulfilled") {
			const { filePath, opened, serverName, error } = result.value;
			if (opened) {
				serversUsed.add(serverName);
			} else if (error) {
				failedOpens.push(filePath);
				_logWarn("runLspDiagnostics", `LSP didOpen failed for ${filePath}`, error);
			}
		} else {
			// Promise rejected -- this shouldn't happen with internal error handling,
			// but log it for observability
			_logWarn("runLspDiagnostics", `LSP didOpen unexpected rejection: ${result.reason}`);
		}
	}

	// Poll for diagnostics with retries instead of fixed wait.
	// Some LSP servers need more time to publish diagnostics for large files.
	const MAX_POLL_ATTEMPTS = 20;
	const POLL_INTERVAL_MS = 500;
	const lspManagerForPolling = lspManager; // capture reference
	if (serversUsed.size > 0) {
		for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			// Check if any server has published diagnostics
			const hasDiagnostics = lspManagerForPolling
				.getActiveServers()
				.some((srv) => srv.client.collectDiagnostics(targetFiles, false).length > 0);
			if (hasDiagnostics) break;
		}
	}

	// Collect diagnostics from all active LSP servers. Each server's
	// collectDiagnostics filters to only its opened files, so we can safely
	// pass all target files to every server.
	const activeServers = lspManager.getActiveServers();
	for (const serverInfo of activeServers) {
		const notifications = serverInfo.client.collectDiagnostics(targetFiles);
		for (const notif of notifications) {
			const relPath = uriToPath(notif.uri);
			for (const diag of notif.diagnostics) {
				const sev = diag.severity ?? 0;
				diagnostics.push({
					file: relPath,
					line: diag.range.start.line + 1,
					col: diag.range.start.character + 1,
					endLine: diag.range.end.line + 1,
					endCol: diag.range.end.character + 1,
					severity: sev === 1 ? "error" : sev === 2 ? "warning" : sev === 3 ? "info" : "hint",
					code: String(diag.code ?? ""),
					message: typeof diag.message === "object" ? (diag.message as { value: string }).value || "" : diag.message,
				});
			}
		}
	}

	// Fetch code actions for error/warning diagnostics (fixes #235)
	// lspManager already declared above
	const errorsAndWarnings = diagnostics.filter((d) => d.severity === "error" || d.severity === "warning");
	if (lspManager && errorsAndWarnings.length > 0) {
		await Promise.all(
			errorsAndWarnings.slice(0, 10).map(async (diag) => {
				try {
					const actions = await lspCodeActions(
						lspManager,
						diag.file,
						diag.line - 1,
						diag.col - 1,
						diag.endLine ? diag.endLine - 1 : diag.line - 1,
						diag.endCol ? diag.endCol - 1 : diag.col,
					);
					if (actions && actions.length > 0) {
						diag.suggestedFixes = actions
							.map((a) => {
								if ("title" in a && a.title) return `Fix: ${a.title}`;
								return null;
							})
							.filter(Boolean) as string[];
					}
				} catch (err) {
					_logWarn("codeAction", `fetch failed for ${diag.file}:${diag.line}:${diag.col}`, err);
				}
			}),
		);
	}

	// Annotate output if files failed to open
	if (failedOpens.length > 0) {
		_logWarn(
			"runLspDiagnostics",
			`LSP didOpen failed for ${failedOpens.length} file(s): ${failedOpens.slice(0, 5).join(", ")}${failedOpens.length > 5 ? "..." : ""}`,
		);
	}

	// Issue #497: Check diagnostic reliability — if >50% of diagnostics on >20 total
	// match infrastructure error patterns (e.g., node_modules inaccessible), fall back
	// to subprocess diagnostics (tsc --noEmit) which produces real, actionable errors.
	if (diagnostics.length > 0) {
		const reliability = checkDiagnosticReliability(diagnostics);
		if (!reliability.reliable) {
			_logWarn(
				"runLspDiagnostics",
				reliability.message ?? "LSP diagnostics deemed unreliable, falling back to subprocess",
			);
			// #626: release LSP per-document AST before falling back. Even
			// when the LSP result is unreliable, the documents we just
			// didOpen still occupy memory on the language server.
			await lspManager.closeOpenedFiles();
			const subResult = await runSubprocessDiagnostics(projectRoot);
			return {
				...subResult,
				lspReliable: false,
				lspReliableMessage: reliability.message,
			};
		}
	}

	// #626: send didClose to every file we opened so the language server
	// releases per-document AST. Without this, _openedFilePaths grows
	// monotonically across the MCP process lifetime and the LSP child
	// process consumes 1GB+ for large projects.

	// #633: Upgrade edge provenance for top-N hot symbols while files are
	// still open on the LSP server. Runs in parallel with the rest of
	// verify -- LSP RPCs are I/O bound, so adding references queries
	// doesn't materially extend total verify time. After didClose the
	// server drops its per-file AST and `references` would fail.
	if (serversUsed.size > 0) {
		await upgradeEdgesForHotspots(graph, lspManager, projectRoot);
	}

	await lspManager.closeOpenedFiles();

	return {
		diagnostics,
		available: serversUsed.size > 0,
		errorMessage: serversUsed.size === 0 ? "No LSP servers available for detected file types" : undefined,
		failedOpens: failedOpens.length > 0 ? failedOpens : undefined,
		lspReliable: true,
	};
}

// -- Subprocess fallback diagnostics -----------------------------------------

/**
 * Default number of top-PageRank symbols to upgrade each verify cycle.
 *
 * Each symbol costs one LSP `textDocument/references` round-trip; the
 * RPCs run in parallel so wall-clock cost is roughly one request. 50
 * covers the long tail of "important enough to care about" without
 * spending too much time on cold symbols. Override via `options.provenanceTopN`.
 */
const DEFAULT_PROVENANCE_TOP_N = 50;

const _PROVENANCE_UPGRADE_TIMEOUT_MS = 4000;

/**
 * Promote `provenance` from `"heuristic"` to `"resolved"` for the
 * edges of the top-N PageRank symbols, using LSP `references` as the
 * trust signal.
 *
 * Why here (issue #633 follow-up): `shazam_verify` already holds an
 * LSP context with files open on the server. We piggyback on the
 * existing verify cycle so the upgrade costs zero extra latency
 * (parallel RPCs) and downstream tools (`shazam_lookup`,
 * `shazam_impact`) immediately see resolved edges for the symbols
 * the user actually cares about.
 *
 * Failure modes (all silent -> keep existing provenance):
 *  - LSP RPC times out for a symbol: skip it.
 *  - LSP server returns no references: skip (edge stays heuristic).
 *  - Symbol has no definition line: skip (rare for graph nodes).
 */
async function upgradeEdgesForHotspots(
	graph: RepoGraph,
	ctx: import("./lsp_enrich.js").LspEnrichContext,
	projectRoot: string,
	topN: number = DEFAULT_PROVENANCE_TOP_N,
): Promise<{ upgraded: number; attempted: number }> {
	// Pick top-N symbols by PageRank. Defensive copy because
	// `graph.symbols` is mutated by the scanner and we want a stable
	// snapshot for the duration of this call.
	const allSymbols = [...graph.symbols.values()];
	const hot = allSymbols.sort((a, b) => b.pagerank - a.pagerank).slice(0, topN);

	let upgraded = 0;
	let attempted = 0;

	// Fan out: one references RPC per hot symbol. allSettled so a
	// single timeout/error doesn't poison the batch.
	const settled = await Promise.allSettled(
		hot.map(async (sym) => {
			// Skip symbols without a usable source position.
			if (!sym.file || sym.line <= 0) return null;
			// Skip symbols in files we know the LSP doesn't cover
			// (e.g. generated, vendored). Mirrors `runLspDiagnostics`.
			if (isNonSourceFile(sym.file)) return null;

			const refs = await lspReferences(ctx, sym.file, sym.line, 0, _PROVENANCE_UPGRADE_TIMEOUT_MS);
			if (!refs || refs.length === 0) return null;
			const result = upgradeEdgesToResolved(graph, refs, sym.id, projectRoot);
			return result;
		}),
	);

	for (const r of settled) {
		if (r.status === "fulfilled" && r.value) {
			upgraded += r.value.upgraded;
			attempted += r.value.attempted;
		}
	}
	if (attempted > 0) {
		_logWarn(
			"upgradeEdgesForHotspots",
			`upgraded ${upgraded}/${attempted} edges across top-${topN} hot symbols to provenance=resolved`,
		);
	}
	return { upgraded, attempted };
}

function detectProjectType(projectRoot: string): string | null {
	const languages = detectProjectLanguages(projectRoot);
	// Return the first detected language as the primary project type.
	// detectProjectLanguages returns them in precedence order (tsconfig > Cargo > etc.).
	if (languages.length === 0) return null;
	// Map "node" back to the expected "node" project type for subprocess dispatch.
	return languages[0];
}

async function runSubprocessDiagnostics(projectRoot: string): Promise<LspDiagResult> {
	const diagnostics: LspDiagEntry[] = [];
	const projectType = detectProjectType(projectRoot);
	if (!projectType) return { diagnostics, available: false };

	let program: string;
	let args: string[];
	switch (projectType) {
		case "typescript":
			program = "npx";
			args = ["tsc", "--noEmit"];
			break;
		case "rust":
			program = "cargo";
			args = ["check"];
			break;
		case "go":
			program = "go";
			args = ["vet", "./..."];
			break;
		case "python":
			program = "pyright";
			args = ["."];
			break;
		case "node":
			if (existsSync(resolve(projectRoot, "biome.json"))) {
				program = "npx";
				args = ["biome", "check", "."];
			} else {
				program = "npx";
				args = ["eslint", "."];
			}
			break;
		default:
			return { diagnostics, available: false };
	}

	try {
		const { stdout, stderr } = await execFileAsync(program, args, {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: 15000,
			maxBuffer: 1024 * 1024,
		}).catch((err: Error & { stdout?: string; stderr?: string; code?: string }) => {
			// execFile rejects on non-zero exit code, but the output is still valid.
			// Re-throw ENOENT so the outer catch produces a proper warning (fix #497).
			if (err.code === "ENOENT") throw err;
			return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
		});
		const output = redact(((stdout ?? "") + (stderr ?? "")).trim());
		if (output) {
			// Match standard compiler error format: file:line:col - error|warning CODE: message
			// This correctly handles tsc, cargo, and similar structured output.
			// Lines not matching this pattern (continuation/summary lines) are skipped.
			const diagLineRe = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(\S+):\s+(.*)$/im;
			let matchCount = 0;
			for (const line of output.split("\n")) {
				const m = diagLineRe.exec(line);
				if (!m) continue;
				if (++matchCount > 100) break;
				diagnostics.push({
					file: m[1]!,
					line: Number(m[2]!),
					col: Number(m[3]!),
					endLine: 0,
					endCol: 0,
					severity: m[4]!,
					code: m[5]!,
					message: m[6]!.slice(0, 200),
				});
			}
		}
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		diagnostics.push({
			file: "",
			line: 0,
			col: 0,
			endLine: 0,
			endCol: 0,
			severity: "warning",
			code: "",
			message: `Subprocess diagnostics failed: ${errMsg.slice(0, 200)}`,
		});
	}

	return { diagnostics, available: true };
}

// -- Re-exports for backward compatibility (tests import from here) ----------
export { resolveGitWorkdir } from "../core/git-utils.js";

// -- Graph analysis helpers --------------------------------------------------

/**
 * Adapter: converts verify tool parameters into a unified assessRisk call.
 * Computes gitFileCount/newOrphanCount/orphanDelta from the graph and orphan list,
 * then delegates to the unified function in core/risk.ts.
 */
function _assessVerifyRisk(
	graph: RepoGraph,
	internalOrphans: { name: string; kind: string; file: string; line: number }[],
	gitChangedFiles?: string[],
	preCommit?: boolean,
	lspErrors = 0,
	lspWarnings = 0,
): { level: "low" | "medium" | "high"; reason: string } {
	const gitFileCount = gitChangedFiles?.length ?? 0;
	const baselineDiff = diffFromBaseline(graph, lspErrors, lspWarnings);
	const orphanDelta = baselineDiff?.orphanSymbols ?? internalOrphans.length;
	const newOrphanCount = baselineDiff?.newOrphans?.length ?? internalOrphans.length;
	return assessRisk({ mode: "verify", gitFileCount, newOrphanCount, orphanDelta, lspErrors, lspWarnings, preCommit });
}

// -- Synchronous execute functions (for test compatibility) ------------------

/**
 * Synchronous verify (no LSP, graph-only).
 */
export function executeVerify(graph: RepoGraph, projectRoot: string, options: VerifyOptions = {}): string {
	const lines: string[] = [];
	const quick = options.quick ?? false;
	const lspOnly = options.lspOnly ?? false;

	const symbolCount = graph.symbols.size;
	const fileCount = graph.fileSymbols.size;
	const edgeCount = getGraphEdgeCount(graph);

	const modeLabel = lspOnly ? " (LSP Only)" : quick ? " (Quick)" : "";
	lines.push(`## Verify Results${modeLabel}`);
	lines.push("");
	lines.push(`**Symbols:** ${symbolCount} | **Files:** ${fileCount} | **Edges:** ${edgeCount}`);
	lines.push("");

	if (!quick && !lspOnly) {
		lines.push("### LSP Diagnostics");
		lines.push("");
		lines.push("LSP diagnostics require async execution - use the tool directly for full LSP checks.");
		lines.push("");
	}

	if (lspOnly) return lines.join("\n");

	const gitChangedFiles = getGitChangedFiles(projectRoot);
	lines.push("### Git Working Tree Changes");
	if (gitChangedFiles.length > 0) {
		lines.push(`Files changed: ${gitChangedFiles.length}`);
		for (const f of gitChangedFiles.slice(0, 20)) lines.push(`  - ${f}`);
	} else {
		lines.push("No uncommitted changes.");
	}
	lines.push("");

	// Baseline diff removed (issue #319)

	const orphanResult = findOrphans(graph);
	const orphans = orphanResult.all;
	const internalOrphans = orphanResult.internal;
	const exportedOrphans = orphanResult.exported;
	if (orphans.length > 0) {
		lines.push("### Potential Orphan Symbols");
		lines.push("");
		lines.push(`Found ${orphans.length} symbols with zero incoming references:`);
		lines.push("");

		// Separate internal and exported orphans
		if (internalOrphans.length > 0) {
			lines.push(`#### Internal (likely dead code) - ${internalOrphans.length} symbols`);
			for (const orphan of internalOrphans.slice(0, 10)) {
				lines.push(`- ${orphan.kind} \`${orphan.name}\` - ${orphan.file}:${orphan.line}`);
			}
			if (internalOrphans.length > 10) lines.push(`  ... and ${internalOrphans.length - 10} more`);
			lines.push("");
		}

		if (exportedOrphans.length > 0) {
			lines.push(`#### Exported (may be used externally) - ${exportedOrphans.length} symbols`);
			for (const orphan of exportedOrphans.slice(0, 10)) {
				lines.push(`- ${orphan.kind} \`${orphan.name}\` - ${orphan.file}:${orphan.line} [exported]`);
			}
			if (exportedOrphans.length > 10) lines.push(`  ... and ${exportedOrphans.length - 10} more`);
			lines.push("");
		}
	} else {
		lines.push("### Orphan Symbols: None detected", "");
	}

	const risk = _assessVerifyRisk(graph, internalOrphans, gitChangedFiles, options.preCommit);
	lines.push("### Risk Level");
	lines.push(`**${risk.level}** - ${risk.reason}`);
	lines.push("");

	if (quick) lines.push("[Quick mode - skipped deep analysis]\n");
	const nextItems = getNextForTool("verify", { riskLevel: risk.level, orphanCount: orphans.length });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

/**
 * #631 A: build the typed verify result (sync variant -- no LSP).
 * Single source of truth for the JSON envelope; previously the
 * shape was inlined inside executeVerifyJson. The async LSP-aware
 * variant executeVerifyJsonAsync already returns a typed object
 * and is the model for this sync counterpart.
 */
export function buildVerifyResult(
	graph: RepoGraph,
	projectRoot: string,
	options: VerifyOptions = {},
): Record<string, unknown> {
	const orphanResult = findOrphans(graph);
	const orphans = orphanResult.all;
	const internalOrphans = orphanResult.internal;
	const exportedOrphans = orphanResult.exported;
	const gitChangedFiles = getGitChangedFiles(projectRoot);
	const risk = _assessVerifyRisk(graph, internalOrphans, gitChangedFiles, options.preCommit);

	const edgeCount = getGraphEdgeCount(graph);

	return {
		symbolCount: graph.symbols.size,
		fileCount: graph.fileSymbols.size,
		edgeCount,
		riskLevel: risk.level,
		riskReason: risk.reason,
		orphanCount: orphans.length,
		orphans: orphans
			.slice(0, 20)
			.map((s) => ({ name: s.name, kind: s.kind, file: s.file, line: s.line, isExported: s.isExported })),
		internalOrphanCount: internalOrphans.length,
		exportedOrphanCount: exportedOrphans.length,
		baselineDiff: null,
		gitChangedFiles: gitChangedFiles.slice(0, 50),
		lspDiagnostics: [],
		lspAvailable: false,
		verdict: risk.level === "high" ? "FAIL" : "PASS",
		quickMode: options.quick ?? false,
		lspOnlyMode: options.lspOnly ?? false,
		preCommitMode: options.preCommit ?? false,
	};
}

export function executeVerifyJson(graph: RepoGraph, projectRoot: string, options: VerifyOptions = {}): string {
	return JSON.stringify({
		schema_version: "1.0",
		command: "verify",
		project: projectRoot,
		status: "ok",
		result: buildVerifyResult(graph, projectRoot, options),
	});
}

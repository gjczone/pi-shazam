/**
 * pi-shazam tools/verify — Unified post-edit verification gate.
 *
 * Merges verify, check, and ready into one tool:
 *   1. LSP diagnostics (CORE) — type errors, warnings from language servers
 *   2. Graph analysis (SUPPLEMENTARY) — git diff, risk, orphans, graph diff
 *   3. Summary verdict — PASS / WARN / FAIL
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
import { isNonSourceFile, findOrphans } from "../core/filter.js";
import { execFile } from "node:child_process";
import { getGitChangedFiles } from "../core/git-utils.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync } from "node:fs";
import { redact } from "../core/redact.js";
import { readFileAdaptiveAsync } from "../core/encoding.js";
import { resolve } from "node:path";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { lspCodeActions } from "./lsp_enrich.js";
import { createTool } from "./_factory.js";
import { uriToPath } from "../lsp/client.js";

export function registerVerify(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_verify",
		label: "Verify Changes",
		description: `\
		After every write or edit, run this to confirm no errors were
		introduced. Runs LSP diagnostics (type errors, warnings), then graph
		analysis (git diff, risk level, orphan detection, graph diffs).
		Verdict: PASS / WARN / FAIL. Use --quick for a fast git-change-only
		check (~2s). Use --lspOnly for diagnostics only. Use --preCommit for
		stricter thresholds.`,
		params: Type.Object({
			quick: Type.Optional(Type.Boolean()),
			lspOnly: Type.Optional(Type.Boolean()),
			preCommit: Type.Optional(Type.Boolean()),
			delta: Type.Optional(Type.Boolean()),
			maxFiles: Type.Optional(Type.Number()),
			noCascade: Type.Optional(Type.Boolean()),
			noSecrets: Type.Optional(Type.Boolean()),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens;
			const projectRoot = (params.project as string) || process.cwd();
			const options: VerifyOptions = {
				quick: (params.quick as boolean) ?? false,
				lspOnly: (params.lspOnly as boolean) ?? false,
				preCommit: (params.preCommit as boolean) ?? false,
				delta: (params.delta as boolean) ?? false,
				maxFiles: (params.maxFiles as number) ?? 100,
				noCascade: (params.noCascade as boolean) ?? false,
				noSecrets: (params.noSecrets as boolean) ?? false,
			};

			let text: string;
			if (json) {
				const result = await executeVerifyJsonAsync(projectRoot, options);
				text = JSON.stringify({ schema_version: "1.0", command: "verify", project: projectRoot, status: "ok", result });
			} else {
				text = await executeVerifyTextAsync(projectRoot, options);
			}

			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens as number);
			}
			return { content: [{ type: "text", text }] };
		},
	});
}

// -- Verify options ----------------------------------------------------------

export interface VerifyOptions {
	quick?: boolean;
	lspOnly?: boolean;
	preCommit?: boolean;
	delta?: boolean;
	maxFiles?: number;
	noCascade?: boolean;
	noSecrets?: boolean;
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
	if (lspOnly || !quick) {
		const lspResult = await runLspDiagnostics(graph, projectRoot, options);
		lspDiagnostics = lspResult.diagnostics;
		lspAvailable = lspResult.available;
	}

	// JSON mode: early return for lspOnly (skip graph analysis, same as text mode)
	if (lspOnly) {
		return {
			symbolCount: graph.symbols.size,
			fileCount: graph.fileSymbols.size,
			edgeCount: getGraphEdgeCount(graph),
			riskLevel: "low",
			riskReason: "lspOnly mode — graph analysis skipped",
			orphanCount: 0,
			orphans: [],
			internalOrphanCount: 0,
			exportedOrphanCount: 0,
			gitChangedFiles: [],
			baselineDiff: null,
			lspDiagnostics,
			lspAvailable,
			verdict: lspDiagnostics.some((d) => d.severity === "error") ? "FAIL" : "PASS",
			quickMode: quick,
			lspOnlyMode: lspOnly,
			preCommitMode: preCommit,
		};
	}

	const lspErrors = lspDiagnostics.filter((d) => d.severity === "error").length;
	const lspWarnings = lspDiagnostics.filter((d) => d.severity === "warning").length;
	const risk = _assessVerifyRisk(graph, internalOrphans, gitChangedFiles, preCommit, lspErrors, lspWarnings);

	let verdict = "PASS";
	if (lspDiagnostics.some((d) => d.severity === "error")) {
		verdict = "FAIL";
	} else if (!lspAvailable && !quick && !lspOnly) {
		verdict = "WARN";
	} else if (preCommit && risk.level !== "low") {
		verdict = "FAIL";
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

	// LSP diagnostics (CORE) — show all errors
	let lspResult: LspDiagResult = { diagnostics: [], available: false };
	if (!quick) {
		lspResult = await runLspDiagnostics(graph, projectRoot, options);
		lines.push("### LSP Diagnostics");
		lines.push("");
		if (!lspResult.available) {
			lines.push("[WARN] LSP diagnostics unavailable — type/lint errors not checked.");
			if (lspResult.errorMessage) {
				lines.push(`  Reason: ${lspResult.errorMessage}`);
			}
			lines.push(
				"  To fix: Install language servers (e.g., typescript-language-server, pyright, gopls, rust-analyzer)",
			);
		} else if (lspResult.diagnostics.length === 0) {
			lines.push("[PASS] No diagnostics found.");
		} else {
			const errors = lspResult.diagnostics.filter((d) => d.severity === "error");
			const warnings = lspResult.diagnostics.filter((d) => d.severity === "warning");
			lines.push(`Errors: ${errors.length} | Warnings: ${warnings.length} | Total: ${lspResult.diagnostics.length}`);
			lines.push("");
			// Show ALL errors (errors are critical, not noise)
			for (const d of errors) {
				const sevLabel = d.severity.toUpperCase();
				const code = d.code ? ` (${d.code})` : "";
				lines.push(`- [${sevLabel}] ${d.file}:${d.line}:${d.col}${code} — ${d.message}`);
				if (d.suggestedFixes && d.suggestedFixes.length > 0) {
					for (const fix of d.suggestedFixes.slice(0, 3)) {
						lines.push(`    ${fix}`);
					}
				}
			}
			// Show first 10 warnings (warnings are less critical)
			for (const d of warnings.slice(0, 10)) {
				const sevLabel = d.severity.toUpperCase();
				const code = d.code ? ` (${d.code})` : "";
				lines.push(`- [${sevLabel}] ${d.file}:${d.line}:${d.col}${code} — ${d.message}`);
				if (d.suggestedFixes && d.suggestedFixes.length > 0) {
					for (const fix of d.suggestedFixes.slice(0, 3)) {
						lines.push(`    ${fix}`);
					}
				}
			}
			if (warnings.length > 10) {
				lines.push(`... and ${warnings.length - 10} more warnings`);
			}
		}
		lines.push("");
	}

	if (lspOnly) {
		const lspVerdict = lspResult.diagnostics.some((d) => d.severity === "error") ? "FAIL" : "PASS";
		lines.push("### Verdict: " + lspVerdict);
		lines.push("");
		lines.push("[lspOnly mode — graph analysis skipped]");
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
	const delta = options.delta ?? false;

	// Filter orphans (delta mode disabled — diffBaseline removed, issue #319)
	let displayOrphans = orphans;

	if (displayOrphans.length > 0) {
		const deltaLabel = delta ? " (new since baseline)" : "";
		lines.push("### Potential Orphan Symbols");
		lines.push("");
		lines.push(`Found ${displayOrphans.length} symbols with zero incoming references${deltaLabel}:`);
		lines.push("");

		// Separate internal and exported orphans
		if (internalOrphans.length > 0) {
			lines.push(`#### Internal (likely dead code) — ${internalOrphans.length} symbols`);
			for (const orphan of internalOrphans.slice(0, 10)) {
				lines.push(`- ${orphan.kind} \`${orphan.name}\` — ${orphan.file}:${orphan.line}`);
			}
			if (internalOrphans.length > 10) lines.push(`  ... and ${internalOrphans.length - 10} more`);
			lines.push("");
		}

		if (exportedOrphans.length > 0) {
			lines.push(`#### Exported (may be used externally) — ${exportedOrphans.length} symbols`);
			for (const orphan of exportedOrphans.slice(0, 10)) {
				lines.push(`- ${orphan.kind} \`${orphan.name}\` — ${orphan.file}:${orphan.line} [exported]`);
			}
			if (exportedOrphans.length > 10) lines.push(`  ... and ${exportedOrphans.length - 10} more`);
			lines.push("");
		}
	} else {
		lines.push("### Orphan Symbols: None detected", "");
	}

	const lspErrors = lspResult.diagnostics.filter((d) => d.severity === "error").length;
	const lspWarnings = lspResult.diagnostics.filter((d) => d.severity === "warning").length;
	const risk = _assessVerifyRisk(graph, internalOrphans, gitChangedFiles, preCommit, lspErrors, lspWarnings);
	lines.push("### Risk Level");
	lines.push(`**${risk.level}** — ${risk.reason}`);
	lines.push("");

	if (quick) lines.push("[Quick mode — skipped deep analysis]\n");

	if (preCommit) {
		// Reuse the LSP result from above — do NOT call runLspDiagnostics again
		// (collectDiagnostics is destructive, second call returns empty results)
		const hasLspErrors = lspResult.diagnostics.some((d) => d.severity === "error");
		const isReady = !hasLspErrors && risk.level === "low" && internalOrphans.length === 0;
		lines.push("### Pre-Commit Verdict");
		lines.push(`**Status:** ${isReady ? "[PASS] READY" : "[FAIL] NOT READY"}`);
		lines.push("");
		if (!isReady) {
			lines.push("### Issues to Fix Before Commit");
			lines.push("");
			if (hasLspErrors) lines.push("- LSP errors found — fix type errors before commit");
			if (risk.level !== "low") lines.push(`- Risk level is **${risk.level}** — review affected files`);
			if (internalOrphans.length > 0)
				lines.push(`- ${internalOrphans.length} internal orphan symbol(s) — review for dead code`);
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
		console.warn("[pi-shazam] LSP manager not available, falling back to subprocess diagnostics");
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
				const content = await readFileAdaptiveAsync(resolve(projectRoot, filePath));
				await serverInfo.client.didOpen(filePath, content);
				// Track for crash recovery
				lspManager.trackOpenedFile(serverInfo.language, filePath);
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
				console.warn(
					`[pi-shazam] LSP didOpen failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else {
			// Promise rejected — this shouldn't happen with internal error handling,
			// but log it for observability
			console.warn(`[pi-shazam] LSP didOpen unexpected rejection: ${result.reason}`);
		}
	}

	// Poll for diagnostics with retries instead of fixed wait.
	// Some LSP servers need more time to publish diagnostics for large files.
	const MAX_POLL_ATTEMPTS = 5;
	const POLL_INTERVAL_MS = 200;
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
				} catch {
					console.warn(`[pi-shazam] codeAction fetch failed for ${diag.file}:${diag.line}:${diag.col}`);
				}
			}),
		);
	}

	// Annotate output if files failed to open
	if (failedOpens.length > 0) {
		console.warn(
			`[pi-shazam] LSP didOpen failed for ${failedOpens.length} file(s): ${failedOpens.slice(0, 5).join(", ")}${failedOpens.length > 5 ? "..." : ""}`,
		);
	}

	return {
		diagnostics,
		available: serversUsed.size > 0,
		errorMessage: serversUsed.size === 0 ? "No LSP servers available for detected file types" : undefined,
	};
}

// -- Subprocess fallback diagnostics -----------------------------------------

function detectProjectType(projectRoot: string): string | null {
	if (existsSync(resolve(projectRoot, "tsconfig.json"))) return "typescript";
	if (existsSync(resolve(projectRoot, "Cargo.toml"))) return "rust";
	if (existsSync(resolve(projectRoot, "go.mod"))) return "go";
	if (existsSync(resolve(projectRoot, "pyproject.toml"))) return "python";
	if (existsSync(resolve(projectRoot, "setup.py"))) return "python";
	if (existsSync(resolve(projectRoot, "package.json"))) return "node";
	return null;
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
		}).catch((err: { stdout?: string; stderr?: string }) => {
			// execFile rejects on non-zero exit code, but the output is still valid
			return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
		});
		const output = redact(((stdout ?? "") + (stderr ?? "")).trim());
		if (output) {
			for (const line of output.split("\n").slice(0, 100)) {
				if (line.trim()) {
					diagnostics.push({
						file: "",
						line: 0,
						col: 0,
						endLine: 0,
						endCol: 0,
						severity: "info",
						code: "",
						message: line.trim().slice(0, 200),
					});
				}
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
	return assessRisk({ gitFileCount, newOrphanCount, orphanDelta, lspErrors, lspWarnings, preCommit });
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
		lines.push("LSP diagnostics require async execution — use the tool directly for full LSP checks.");
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
			lines.push(`#### Internal (likely dead code) — ${internalOrphans.length} symbols`);
			for (const orphan of internalOrphans.slice(0, 10)) {
				lines.push(`- ${orphan.kind} \`${orphan.name}\` — ${orphan.file}:${orphan.line}`);
			}
			if (internalOrphans.length > 10) lines.push(`  ... and ${internalOrphans.length - 10} more`);
			lines.push("");
		}

		if (exportedOrphans.length > 0) {
			lines.push(`#### Exported (may be used externally) — ${exportedOrphans.length} symbols`);
			for (const orphan of exportedOrphans.slice(0, 10)) {
				lines.push(`- ${orphan.kind} \`${orphan.name}\` — ${orphan.file}:${orphan.line} [exported]`);
			}
			if (exportedOrphans.length > 10) lines.push(`  ... and ${exportedOrphans.length - 10} more`);
			lines.push("");
		}
	} else {
		lines.push("### Orphan Symbols: None detected", "");
	}

	const risk = _assessVerifyRisk(graph, internalOrphans, gitChangedFiles, options.preCommit);
	lines.push("### Risk Level");
	lines.push(`**${risk.level}** — ${risk.reason}`);
	lines.push("");

	if (quick) lines.push("[Quick mode — skipped deep analysis]\n");
	const nextItems = getNextForTool("verify", { riskLevel: risk.level, orphanCount: orphans.length });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

export function executeVerifyJson(graph: RepoGraph, projectRoot: string, options: VerifyOptions = {}): string {
	const orphanResult = findOrphans(graph);
	const orphans = orphanResult.all;
	const internalOrphans = orphanResult.internal;
	const exportedOrphans = orphanResult.exported;
	const gitChangedFiles = getGitChangedFiles(projectRoot);
	const risk = _assessVerifyRisk(graph, internalOrphans, gitChangedFiles, options.preCommit);

	const edgeCount = getGraphEdgeCount(graph);

	return JSON.stringify({
		schema_version: "1.0",
		command: "verify",
		project: projectRoot,
		status: "ok",
		result: {
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
		},
	});
}

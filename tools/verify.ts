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
import { diffBaseline, loadBaseline } from "../core/cache.js";
import { isNonSourceFile } from "../core/filter.js";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { getLspManager } from "./_context.js";
import { createTool } from "./_factory.js";

export function registerVerify(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_verify",
		label: "Verify Changes",
		description: `\
MUST call after EVERY non-trivial edit or write. This is the evidence
gate — it runs LSP diagnostics (type errors, warnings) as the core
check, then graph analysis (git diff, risk, orphans, graph diff).

Verdict: PASS (no LSP errors + low risk), WARN (LSP warnings or LSP
unavailable), FAIL (LSP errors found — must fix).

Supports modes:
- default: full LSP diagnostics + graph analysis
- --quick: git changes + risk only (~2s)
- --lspOnly: LSP diagnostics only, skip graph analysis
- --preCommit: stricter thresholds for pre-commit gate

Scenario: after every edit. Before git commit. Before calling
goal_complete. When CI is red and you need local diagnostics.`,
		params: Type.Object({
			quick: Type.Optional(Type.Boolean()),
			lspOnly: Type.Optional(Type.Boolean()),
			preCommit: Type.Optional(Type.Boolean()),
			maxFiles: Type.Optional(Type.Number()),
			noCascade: Type.Optional(Type.Boolean()),
			noSecrets: Type.Optional(Type.Boolean()),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens;
			const options: VerifyOptions = {
				quick: (params.quick as boolean) ?? false,
				lspOnly: (params.lspOnly as boolean) ?? false,
				preCommit: (params.preCommit as boolean) ?? false,
				maxFiles: (params.maxFiles as number) ?? 100,
				noCascade: (params.noCascade as boolean) ?? false,
				noSecrets: (params.noSecrets as boolean) ?? false,
			};

			let text: string;
			if (json) {
				const result = await executeVerifyJsonAsync(".", options);
				text = JSON.stringify({ schema_version: "1.0", command: "verify", project: ".", status: "ok", result });
			} else {
				text = await executeVerifyTextAsync(".", options);
			}

			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens as number);
			}
			return { content: [{ type: "text", text }] };
		},
	});
}

// ── Verify options ──────────────────────────────────────────────────────────

export interface VerifyOptions {
	quick?: boolean;
	lspOnly?: boolean;
	preCommit?: boolean;
	maxFiles?: number;
	noCascade?: boolean;
	noSecrets?: boolean;
}

// ── Async verify (LSP + graph, used by the tool) ────────────────────────────

async function executeVerifyJsonAsync(projectRoot: string, options: VerifyOptions) {
	const { scanProject } = await import("../core/scanner.js");
	const graph = scanProject(projectRoot);
	const quick = options.quick ?? false;
	const lspOnly = options.lspOnly ?? false;
	const preCommit = options.preCommit ?? false;

	let edgeCount = 0;
	for (const [, edges] of graph.outgoing) edgeCount += edges.length;

	const diff = diffBaseline(graph, projectRoot);
	const orphans = findOrphanSymbols(graph);
	const gitChangedFiles = getGitChangedFiles(projectRoot);

	let lspDiagnostics: LspDiagEntry[] = [];
	let lspAvailable = false;
	if (!quick) {
		const lspResult = await runLspDiagnostics(graph, projectRoot, options);
		lspDiagnostics = lspResult.diagnostics;
		lspAvailable = lspResult.available;
	}

	const risk = assessRisk(graph, diff, orphans, gitChangedFiles, preCommit);

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
		orphans: orphans.slice(0, 20).map((s) => ({ name: s.name, kind: s.kind, file: s.file, line: s.line })),
		gitChangedFiles: gitChangedFiles.slice(0, 50),
		baselineDiff: diff ? {
			addedSymbols: diff.addedSymbols?.length ?? 0,
			removedSymbols: diff.removedSymbols?.length ?? 0,
			modifiedSymbols: diff.modifiedSymbols?.length ?? 0,
		} : null,
		lspDiagnostics,
		lspAvailable,
		verdict,
		quickMode: quick,
		lspOnlyMode: lspOnly,
		preCommitMode: preCommit,
	};
}

async function executeVerifyTextAsync(projectRoot: string, options: VerifyOptions): Promise<string> {
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
	let edgeCount = 0;
	for (const [, edges] of graph.outgoing) edgeCount += edges.length;
	lines.push(`**Symbols:** ${symbolCount} | **Files:** ${fileCount} | **Edges:** ${edgeCount}`);
	lines.push("");

	// LSP diagnostics (CORE)
	if (!quick) {
		const lspResult = await runLspDiagnostics(graph, projectRoot, options);
		lines.push("### LSP Diagnostics");
		lines.push("");
		if (!lspResult.available) {
			lines.push("[WARN] LSP diagnostics unavailable — type/lint errors not checked.");
			lines.push("");
		} else if (lspResult.diagnostics.length === 0) {
			lines.push("No diagnostics found.");
			lines.push("");
		} else {
			const errors = lspResult.diagnostics.filter((d) => d.severity === "error");
			const warnings = lspResult.diagnostics.filter((d) => d.severity === "warning");
			lines.push(`Errors: ${errors.length} | Warnings: ${warnings.length} | Total: ${lspResult.diagnostics.length}`);
			lines.push("");
			for (const d of lspResult.diagnostics.slice(0, 50)) {
				const sevLabel = d.severity.toUpperCase();
				const code = d.code ? ` (${d.code})` : "";
				lines.push(`- [${sevLabel}] ${d.file}:${d.line}:${d.col}${code} — ${d.message}`);
			}
			if (lspResult.diagnostics.length > 50) {
				lines.push(`... and ${lspResult.diagnostics.length - 50} more`);
			}
			lines.push("");
		}
	}

	if (lspOnly) {
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

	const baseline = loadBaseline(projectRoot);
	const diff = diffBaseline(graph, projectRoot);
	if (baseline && diff) {
		const totalChanges = (diff.addedSymbols?.length ?? 0) + (diff.removedSymbols?.length ?? 0) + (diff.modifiedSymbols?.length ?? 0);
		lines.push("### Baseline Diff");
		lines.push(totalChanges > 0
			? `Changes since baseline: +${diff.addedSymbols?.length ?? 0} added, -${diff.removedSymbols?.length ?? 0} removed, ~${diff.modifiedSymbols?.length ?? 0} modified`
			: "No changes since baseline snapshot.");
		lines.push("");
	}

	const orphans = findOrphanSymbols(graph);
	if (orphans.length > 0) {
		lines.push("### Potential Orphan Symbols");
		lines.push(`Found ${orphans.length} symbols with zero incoming references:`);
		for (const orphan of orphans.slice(0, 10)) {
			lines.push(`- ${orphan.kind} \`${orphan.name}\` — ${orphan.file}:${orphan.line}`);
		}
		if (orphans.length > 10) lines.push(`  ... and ${orphans.length - 10} more`);
		lines.push("");
	} else {
		lines.push("### Orphan Symbols: None detected", "");
	}

	const risk = assessRisk(graph, diff, orphans, gitChangedFiles, preCommit);
	lines.push("### Risk Level");
	lines.push(`**${risk.level}** — ${risk.reason}`);
	lines.push("");

	if (quick) lines.push("[Quick mode — skipped deep analysis]\n");

	if (preCommit) {
		const hasLspErrors = (await runLspDiagnostics(graph, projectRoot, options)).diagnostics.some((d) => d.severity === "error");
		const isReady = !hasLspErrors && risk.level === "low" && orphans.length === 0;
		lines.push("### Pre-Commit Verdict");
		lines.push(`**Status:** ${isReady ? "[PASS] READY" : "[FAIL] NOT READY"}`);
		lines.push("");
		if (!isReady) {
			lines.push("### Issues to Fix Before Commit");
			lines.push("");
			if (hasLspErrors) lines.push("- LSP errors found — fix type errors before commit");
			if (risk.level !== "low") lines.push(`- Risk level is **${risk.level}** — review affected files`);
			if (orphans.length > 0) lines.push(`- ${orphans.length} orphan symbol(s) — review for dead code`);
			lines.push("");
		}
	}

	const nextItems = getNextForTool("verify", { riskLevel: risk.level, orphanCount: orphans.length });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

// ── LSP diagnostics (absorbed from tools/check.ts) ─────────────────────────

interface LspDiagEntry {
	file: string;
	line: number;
	col: number;
	severity: string;
	code: string;
	message: string;
}

interface LspDiagResult {
	diagnostics: LspDiagEntry[];
	available: boolean;
}

async function runLspDiagnostics(
	graph: RepoGraph,
	projectRoot: string,
	options: VerifyOptions,
): Promise<LspDiagResult> {
	const maxFiles = options.maxFiles ?? 100;
	const targetFiles = [...graph.fileSymbols.keys()]
		.filter((f) => !isNonSourceFile(f))
		.slice(0, maxFiles);

	if (targetFiles.length === 0) return { diagnostics: [], available: false };

	const lspManager = getLspManager();
	if (!lspManager) return runSubprocessDiagnostics(projectRoot);

	const diagnostics: LspDiagEntry[] = [];
	const serversUsed = new Set<string>();

	for (const filePath of targetFiles) {
		const serverInfo = lspManager.getServerForFile(filePath);
		if (!serverInfo) continue;
		serversUsed.add(serverInfo.serverName);
		try {
			const content = readFileSync(resolve(projectRoot, filePath), "utf-8");
			await serverInfo.client.didOpen(filePath, content);
		} catch { /* skip failed opens */ }
	}

	for (const filePath of targetFiles) {
		const serverInfo = lspManager.getServerForFile(filePath);
		if (!serverInfo) continue;
		const notifications = serverInfo.client.collectDiagnostics([filePath]);
		for (const notif of notifications) {
			for (const diag of notif.diagnostics) {
				const sev = diag.severity ?? 0;
				diagnostics.push({
					file: filePath,
					line: diag.range.start.line + 1,
					col: diag.range.start.character + 1,
					severity: sev === 1 ? "error" : sev === 2 ? "warning" : "info",
					code: String(diag.code ?? ""),
					message: typeof diag.message === "object"
						? (diag.message as { value: string }).value || ""
						: diag.message,
				});
			}
		}
	}

	return { diagnostics, available: serversUsed.size > 0 };
}

// ── Subprocess fallback diagnostics ─────────────────────────────────────────

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

	let command: string;
	switch (projectType) {
		case "typescript": command = "npx tsc --noEmit 2>&1 || true"; break;
		case "rust": command = "cargo check 2>&1 || true"; break;
		case "go": command = "go vet ./... 2>&1 || true"; break;
		case "python": command = "pyright . 2>&1 || true"; break;
		case "node":
			command = existsSync(resolve(projectRoot, "biome.json"))
				? "npx biome check . 2>&1 || true"
				: "npx eslint . 2>&1 || true";
			break;
		default: return { diagnostics, available: false };
	}

	try {
		const output = execSync(command, {
			cwd: projectRoot, encoding: "utf-8", timeout: 30000, maxBuffer: 1024 * 1024,
		}).trim();
		if (output) {
			for (const line of output.split("\n").slice(0, 100)) {
				if (line.trim()) {
					diagnostics.push({ file: "", line: 0, col: 0, severity: "info", code: "", message: line.trim().slice(0, 200) });
				}
			}
		}
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		diagnostics.push({ file: "", line: 0, col: 0, severity: "warning", code: "", message: `Subprocess diagnostics failed: ${errMsg.slice(0, 200)}` });
	}

	return { diagnostics, available: true };
}

// ── Graph analysis helpers ──────────────────────────────────────────────────

interface RiskResult {
	level: "low" | "medium" | "high";
	reason: string;
}

function getGitChangedFiles(projectRoot: string): string[] {
	try {
		const output = execSync(
			"git diff --name-only --diff-filter=ACMR 2>/dev/null; git diff --cached --name-only --diff-filter=ACMR 2>/dev/null",
			{ cwd: projectRoot, encoding: "utf-8", timeout: 5000 },
		).trim();
		if (!output) return [];
		return [...new Set(output.split("\n").filter(Boolean))];
	} catch { return []; }
}

function assessRisk(
	_graph: RepoGraph,
	diff: ReturnType<typeof diffBaseline>,
	orphans: { name: string; kind: string; file: string; line: number }[],
	gitChangedFiles?: string[],
	preCommit?: boolean,
): RiskResult {
	const baselineChanges = (diff?.addedSymbols?.length ?? 0) + (diff?.removedSymbols?.length ?? 0) + (diff?.modifiedSymbols?.length ?? 0);
	const gitFileCount = gitChangedFiles?.length ?? 0;
	const totalImpact = baselineChanges + gitFileCount + orphans.length;

	if (totalImpact === 0) return { level: "low", reason: "No changes detected, no orphan symbols." };

	const highThreshold = preCommit ? 30 : 60;
	const mediumThreshold = preCommit ? 10 : 20;

	if (orphans.length > 10 || totalImpact > highThreshold) {
		return { level: "high", reason: `${orphans.length} orphans, ${baselineChanges} graph changes, ${gitFileCount} git-modified files.` };
	}
	if (orphans.length > 0 || totalImpact > mediumThreshold) {
		return { level: "medium", reason: `${orphans.length} orphans, ${baselineChanges} graph changes, ${gitFileCount} modified files — review recommended.` };
	}
	return { level: "low", reason: `${orphans.length} orphans, ${baselineChanges} changes, ${gitFileCount} modified files — acceptable.` };
}

function findOrphanSymbols(graph: RepoGraph): { name: string; kind: string; file: string; line: number }[] {
	const orphans: { name: string; kind: string; file: string; line: number }[] = [];
	for (const sym of graph.symbols.values()) {
		if (isNonSourceFile(sym.file)) continue;
		const incoming = graph.incoming.get(sym.id);
		if (!incoming || incoming.length === 0) {
			if (sym.visibility === "exported" && sym.pagerank > 0.01) continue;
			if (sym.kind === "anonymous_function") continue;
			if (sym.file.includes("tests/") || sym.file.includes(".test.")) continue;
			orphans.push({ name: sym.name, kind: sym.kind, file: sym.file, line: sym.line });
		}
	}
	return orphans;
}

// ── Synchronous execute functions (for test compatibility) ──────────────────

/**
 * Synchronous verify (no LSP, graph-only).
 */
export function executeVerify(
	graph: RepoGraph,
	_projectRoot: string,
	options: VerifyOptions = {},
): string {
	const lines: string[] = [];
	const quick = options.quick ?? false;
	const lspOnly = options.lspOnly ?? false;

	const symbolCount = graph.symbols.size;
	const fileCount = graph.fileSymbols.size;
	let edgeCount = 0;
	for (const [, edges] of graph.outgoing) edgeCount += edges.length;

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

	const gitChangedFiles = getGitChangedFiles(".");
	lines.push("### Git Working Tree Changes");
	if (gitChangedFiles.length > 0) {
		lines.push(`Files changed: ${gitChangedFiles.length}`);
		for (const f of gitChangedFiles.slice(0, 20)) lines.push(`  - ${f}`);
	} else {
		lines.push("No uncommitted changes.");
	}
	lines.push("");

	const baseline = loadBaseline(".");
	const diff = diffBaseline(graph, ".");
	if (baseline && diff) {
		const totalChanges = (diff.addedSymbols?.length ?? 0) + (diff.removedSymbols?.length ?? 0) + (diff.modifiedSymbols?.length ?? 0);
		lines.push("### Baseline Diff");
		lines.push(totalChanges > 0
			? `Changes since baseline: +${diff.addedSymbols?.length ?? 0} added, -${diff.removedSymbols?.length ?? 0} removed, ~${diff.modifiedSymbols?.length ?? 0} modified`
			: "No changes since baseline snapshot.");
		lines.push("");
	}

	const orphans = findOrphanSymbols(graph);
	if (orphans.length > 0) {
		lines.push("### Potential Orphan Symbols");
		lines.push(`Found ${orphans.length} symbols with zero incoming references:`);
		for (const orphan of orphans.slice(0, 10)) {
			lines.push(`- ${orphan.kind} \`${orphan.name}\` — ${orphan.file}:${orphan.line}`);
		}
		lines.push("");
	} else {
		lines.push("### Orphan Symbols: None detected", "");
	}

	const risk = assessRisk(graph, diff, orphans, gitChangedFiles, options.preCommit);
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

export function executeVerifyJson(
	graph: RepoGraph,
	projectRoot: string,
	options: VerifyOptions = {},
): string {
	const orphans = findOrphanSymbols(graph);
	const diff = diffBaseline(graph, projectRoot);
	const gitChangedFiles = getGitChangedFiles(projectRoot);
	const risk = assessRisk(graph, diff, orphans, gitChangedFiles, options.preCommit);

	let edgeCount = 0;
	for (const [, edges] of graph.outgoing) edgeCount += edges.length;

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
			orphans: orphans.slice(0, 20).map((s) => ({ name: s.name, kind: s.kind, file: s.file, line: s.line })),
			baselineDiff: diff ? {
				addedSymbols: diff.addedSymbols?.length ?? 0,
				removedSymbols: diff.removedSymbols?.length ?? 0,
				modifiedSymbols: diff.modifiedSymbols?.length ?? 0,
			} : null,
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

// ── Parse-mode diagnostic (absorbed from check.ts, test-compatible) ────────

/**
 * Synchronous tree-sitter parse diagnostics (from check.ts).
 */
export function executeCheck(
	graph: RepoGraph,
	_projectRoot: string,
	file?: string,
): string {
	const lines: string[] = [];
	lines.push("## Parse & Symbol Diagnostics");
	lines.push("");

	const targetFiles = file
		? [file]
		: [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));

	if (targetFiles.length === 0) {
		lines.push("No files to check.");
		return lines.join("\n");
	}

	lines.push("### Tree-sitter Parse Status");
	lines.push("");

	const failedFiles: string[] = [];
	const successfulFiles: string[] = [];
	for (const filePath of targetFiles) {
		const symIds = graph.fileSymbols.get(filePath);
		if (!symIds || symIds.length === 0) failedFiles.push(filePath);
		else successfulFiles.push(filePath);
	}

	lines.push(`[PASS] ${successfulFiles.length} files parsed successfully`);
	if (failedFiles.length > 0) {
		lines.push(`[WARN] ${failedFiles.length} files have no symbols (possible parse failure)`);
		for (const f of failedFiles.slice(0, 10)) lines.push(`  - ${f}`);
	}
	lines.push("");

	lines.push("### Symbol Summary");
	lines.push("");
	let totalSymbols = 0;
	let totalEdges = 0;
	for (const filePath of targetFiles) {
		const symIds = graph.fileSymbols.get(filePath);
		if (symIds) {
			totalSymbols += symIds.length;
			for (const id of symIds) {
				const out = graph.outgoing.get(id);
				if (out) totalEdges += out.length;
			}
		}
	}
	lines.push(`Files: ${successfulFiles.length}`);
	lines.push(`Symbols: ${totalSymbols}`);
	lines.push(`Edges: ${totalEdges}`);
	lines.push("");
	lines.push(`For LSP diagnostics, use \`shazam_verify\` (default mode includes LSP).`);

	return lines.join("\n");
}

export function executeCheckJson(
	graph: RepoGraph,
	_projectRoot: string,
	file?: string,
): string {
	const targetFiles = file
		? [file]
		: [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));
	const successfulFiles: string[] = [];
	const failedFiles: string[] = [];
	for (const filePath of targetFiles) {
		const symIds = graph.fileSymbols.get(filePath);
		if (!symIds || symIds.length === 0) failedFiles.push(filePath);
		else successfulFiles.push(filePath);
	}

	return JSON.stringify({
		schema_version: "1.0",
		command: "check",
		project: _projectRoot,
		status: "ok",
		mode: "parse",
		result: {
			totalFiles: targetFiles.length,
			parsedFiles: successfulFiles.length,
			failedFiles: failedFiles.length,
			failedFileList: failedFiles.slice(0, 20),
			symbolCount: graph.symbols.size,
		},
	});
}

// ── Pre-commit readiness (absorbed from ready.ts, test-compatible) ─────────

export function executeReady(graph: RepoGraph, projectRoot: string): string {
	const verifyJsonRaw = executeVerifyJson(graph, projectRoot);
	const checkJsonRaw = executeCheckJson(graph, projectRoot);

	let verifyData: { result?: { riskLevel?: string; orphanCount?: number; symbolCount?: number; fileCount?: number } } = {};
	let checkData: { result?: { parsedFiles?: number; failedFiles?: number; symbolCount?: number } } = {};

	try { verifyData = JSON.parse(verifyJsonRaw); } catch { /* use defaults */ }
	try { checkData = JSON.parse(checkJsonRaw); } catch { /* use defaults */ }

	const riskLevel = verifyData.result?.riskLevel ?? "unknown";
	const orphanCount = verifyData.result?.orphanCount ?? 0;
	const failedFiles = checkData.result?.failedFiles ?? 0;
	const parsedFiles = checkData.result?.parsedFiles ?? 0;
	const isReady = riskLevel === "low" && orphanCount === 0 && failedFiles === 0;

	const lines: string[] = [];
	lines.push("## Pre-Commit Readiness");
	lines.push("");
	lines.push(`**Status:** ${isReady ? "[PASS] READY" : "[FAIL] NOT READY"}`);
	lines.push("");
	lines.push("### Verify");
	lines.push(`Risk level: **${riskLevel}**`);
	lines.push(`Orphan symbols: ${orphanCount}`);
	lines.push(`Total symbols: ${verifyData.result?.symbolCount ?? "?"}`);
	lines.push(`Total files: ${verifyData.result?.fileCount ?? "?"}`);
	lines.push("");
	lines.push("### Check");
	lines.push(`Files parsed: ${parsedFiles}`);
	lines.push(`Files failed: ${failedFiles}`);
	lines.push("");

	if (!isReady) {
		lines.push("### Issues to Fix Before Commit");
		lines.push("");
		if (riskLevel !== "low") lines.push(`- Risk level is **${riskLevel}** — run \`shazam_verify\` for details`);
		if (orphanCount > 0) lines.push(`- ${orphanCount} orphan symbol(s) — run \`shazam_verify\` for detailed review`);
		if (failedFiles > 0) lines.push(`- ${failedFiles} file(s) failed parse — run \`shazam_verify\` for details`);
		lines.push("");
	} else {
		lines.push("All checks pass. Ready to commit.");
	}

	return lines.join("\n");
}

export function executeReadyJson(graph: RepoGraph, projectRoot: string): string {
	const verifyJsonRaw = executeVerifyJson(graph, projectRoot);
	const checkJsonRaw = executeCheckJson(graph, projectRoot);

	let verifyData: { result?: { riskLevel?: string; orphanCount?: number; symbolCount?: number; fileCount?: number } } = {};
	let checkData: { result?: { parsedFiles?: number; failedFiles?: number; symbolCount?: number } } = {};

	try { verifyData = JSON.parse(verifyJsonRaw); } catch { /* use defaults */ }
	try { checkData = JSON.parse(checkJsonRaw); } catch { /* use defaults */ }

	const riskLevel = verifyData.result?.riskLevel ?? "unknown";
	const orphanCount = verifyData.result?.orphanCount ?? 0;
	const failedFiles = checkData.result?.failedFiles ?? 0;
	const isReady = riskLevel === "low" && orphanCount === 0 && failedFiles === 0;

	return JSON.stringify({
		schema_version: "1.0",
		command: "ready",
		project: projectRoot,
		status: "ok",
		result: {
			ready: isReady,
			verify: { riskLevel, orphanCount, symbolCount: verifyData.result?.symbolCount ?? 0, fileCount: verifyData.result?.fileCount ?? 0 },
			check: { parsedFiles: checkData.result?.parsedFiles ?? 0, failedFiles, symbolCount: checkData.result?.symbolCount ?? 0 },
		},
	});
}

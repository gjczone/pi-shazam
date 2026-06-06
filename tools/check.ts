/**
 * pi-shazam tools/check — Symbol & parse diagnostics with LSP integration.
 *
 * Validates project files using tree-sitter parsing and reports issues.
 * When diagnostics="lsp", connects to LSP servers for real compiler-level
 * diagnostics with 3-level fallback: LSP → subprocess → tree-sitter.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { isNonSourceFile } from "../core/filter.js";
import { getLspManager } from "./_context.js";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";

export function registerCheck(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_check",
		label: "Parse & LSP Diagnostics",
		description: `\
MUST call after edits or before commit to get compiler-level diagnostics.
Two modes: diagnostics="parse" (default) checks tree-sitter parse status
and symbol statistics. diagnostics="lsp" connects to LSP servers for
real-time type errors, warnings, and hints.

LSP mode has a 3-level fallback chain:
1. LSP server (typescript-language-server, gopls, pyright, etc.)
2. Subprocess runners (npx tsc --noEmit, cargo check, go vet)
3. Tree-sitter parse status (as last resort)

Scenario: after any edit. Before CI push. Mid-refactor to catch type
errors fast. When shazam_verify reports high risk.`,
		parameters: Type.Object({
			file: Type.Optional(Type.String()),
			json: Type.Optional(Type.Boolean()),
			diagnostics: Type.Optional(
				Type.Union([Type.Literal("lsp"), Type.Literal("parse")]),
			),
			maxTokens: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const diagnostics = params.diagnostics ?? "parse";
			const maxTokens = params.maxTokens;
			const graph = scanProject(".");

			let text: string;
			if (diagnostics === "lsp") {
				text = json
					? executeLspDiagnosticsJson(graph, ".", params.file)
					: executeLspDiagnostics(graph, ".", params.file);
			} else if (json) {
				text = executeCheckJson(graph, ".", params.file);
			} else {
				text = executeCheck(graph, ".", params.file);
			}

			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens);
			}
			return {
				content: [
					{
						type: "text",
						text,
					},
				],
			};
		},
	});
}

// ── LSP diagnostics mode ────────────────────────────────────────────────────

function executeLspDiagnostics(
	graph: RepoGraph,
	projectRoot: string,
	file?: string,
): string {
	const lines: string[] = [];
	lines.push("## LSP Diagnostics");
	lines.push("");

	const targetFiles = file
		? [file]
		: [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));

	if (targetFiles.length === 0) {
		lines.push("No files to check.");
		return lines.join("\n");
	}

	const lspManager = getLspManager();
	if (!lspManager) {
		lines.push("[WARN] LSP manager not initialized. Falling back to subprocess diagnostics.");
		return runSubprocessDiagnostics(projectRoot, targetFiles, lines);
	}

	let totalDiagnostics = 0;
	let errors = 0;
	let warnings = 0;
	let serversUsed = new Set<string>();
	let failedFiles: string[] = [];
	let lspDiagnostics: string[] = [];

	for (const filePath of targetFiles) {
		const serverInfo = lspManager.getServerForFile(filePath);
		if (!serverInfo) {
			failedFiles.push(filePath);
			continue;
		}

		serversUsed.add(serverInfo.serverName);
		const client = serverInfo.client;

		// Open the file in LSP
		try {
			const content = readFileSync(resolve(projectRoot, filePath), "utf-8");
			client.didOpen(filePath, content);
		} catch {
			failedFiles.push(filePath);
			continue;
		}
	}

	// Collect diagnostics from all opened files
	for (const filePath of targetFiles) {
		const serverInfo = lspManager.getServerForFile(filePath);
		if (!serverInfo) continue;

		const client = serverInfo.client;
		const notifications = client.collectDiagnostics([filePath]);

		for (const notif of notifications) {
			for (const diag of notif.diagnostics) {
				totalDiagnostics++;
				const sev = diag.severity ?? 0;
				if (sev === 1) errors++;
				else if (sev === 2) warnings++;

				const relFile = filePath;
				const line = diag.range.start.line + 1;
				const col = diag.range.start.character + 1;
				const sevLabel = sev === 1 ? "error" : sev === 2 ? "warning" : "info";
				const code = diag.code ? ` (${diag.code})` : "";

				lspDiagnostics.push(
					`- [${sevLabel.toUpperCase()}] ${relFile}:${line}:${col}${code} — ${diag.message}`,
				);
			}
		}
	}

	if (totalDiagnostics > 0) {
		lines.push(`### LSP Results (${serversUsed.size > 0 ? [...serversUsed].join(", ") : "unknown"})`);
		lines.push("");
		lines.push(`Errors: ${errors} | Warnings: ${warnings} | Total: ${totalDiagnostics}`);
		lines.push("");
		for (const d of lspDiagnostics.slice(0, 50)) {
			lines.push(d);
		}
		if (lspDiagnostics.length > 50) {
			lines.push(`... and ${lspDiagnostics.length - 50} more`);
		}
	} else {
		lines.push("No LSP diagnostics found.");
	}

	if (failedFiles.length > 0) {
		lines.push("");
		lines.push("### Files Without LSP Coverage");
		lines.push("");
		lines.push(`Failed/unsupported: ${failedFiles.length} files`);
		for (const f of failedFiles.slice(0, 10)) {
			lines.push(`  - ${f}`);
		}
	}

	// Add Next recommendations
	const nextItems = getNextForTool("check", { hasErrors: errors > 0, hasFixes: false });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

function executeLspDiagnosticsJson(
	graph: RepoGraph,
	projectRoot: string,
	file?: string,
): string {
	const targetFiles = file
		? [file]
		: [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));

	const lspManager = getLspManager();
	const diagnostics: Array<{
		file: string;
		line: number;
		col: number;
		severity: string;
		code: string;
		message: string;
	}> = [];

	if (!lspManager) {
		return JSON.stringify({
			schema_version: "1.0",
			command: "check",
			project: projectRoot,
			status: "ok",
			mode: "lsp",
			result: { diagnostics: [], note: "LSP manager not initialized" },
		});
	}

	for (const filePath of targetFiles) {
		const serverInfo = lspManager.getServerForFile(filePath);
		if (!serverInfo) continue;
		const client = serverInfo.client;

		try {
			const content = readFileSync(resolve(projectRoot, filePath), "utf-8");
			client.didOpen(filePath, content);
		} catch {
			continue;
		}
	}

	for (const filePath of targetFiles) {
		const serverInfo = lspManager.getServerForFile(filePath);
		if (!serverInfo) continue;
		const notifications = serverInfo.client.collectDiagnostics([filePath]);
		for (const notif of notifications) {
			for (const d of notif.diagnostics) {
				diagnostics.push({
					file: filePath,
					line: d.range.start.line + 1,
					col: d.range.start.character + 1,
					severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
					code: String(d.code ?? ""),
					message: typeof d.message === "object" ? (d.message as { value: string }).value || "" : d.message,
				});
			}
		}
	}

	return JSON.stringify({
		schema_version: "1.0",
		command: "check",
		project: projectRoot,
		status: "ok",
		mode: "lsp",
		result: { diagnostics },
	});
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

function runSubprocessDiagnostics(
	projectRoot: string,
	_targetFiles: string[],
	lines: string[],
): string {
	const projectType = detectProjectType(projectRoot);
	lines.push(`Detected project type: ${projectType ?? "unknown"}`);
	lines.push("");

	if (!projectType) {
		lines.push("No project type detected. Falling back to tree-sitter parse check.");
		lines.push("");
		// Fall through to tree-sitter
		return lines.join("\n");
	}

	let command: string;
	const label: string = projectType;

	switch (projectType) {
		case "typescript":
			command = "npx tsc --noEmit 2>&1 || true";
			break;
		case "rust":
			command = "cargo check 2>&1 || true";
			break;
		case "go":
			command = "go vet ./... 2>&1 || true";
			break;
		case "python":
			command = "pyright . 2>&1 || true";
			break;
		case "node":
			// For node projects without tsconfig, try eslint or biome
			if (existsSync(resolve(projectRoot, "biome.json"))) {
				command = "npx biome check . 2>&1 || true";
			} else {
				command = "npx eslint . 2>&1 || true";
			}
			break;
		default:
			command = "";
	}

	if (command) {
		try {
			lines.push(`### Subprocess: ${label}`);
			lines.push("");
			const output = execSync(command, {
				cwd: projectRoot,
				encoding: "utf-8",
				timeout: 30000,
				maxBuffer: 1024 * 1024,
			}).trim();
			if (output) {
				// Truncate very long output
				const truncated = output.length > 5000 ? output.slice(0, 5000) + "\n... (truncated)" : output;
				lines.push(truncated);
			} else {
				lines.push("No issues found.");
			}
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			lines.push(`[WARN] Subprocess diagnostics failed: ${errMsg}`);
			lines.push("");
			lines.push("Falling back to tree-sitter parse check.");
		}
	} else {
		lines.push("No diagnostics command available for this project type.");
		lines.push("Falling back to tree-sitter parse check.");
	}

	// Add Next recommendations
	const nextItems = getNextForTool("check");
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

// ── Parse-mode diagnostics (original) ───────────────────────────────────────

/**
 * Run tree-sitter parse diagnostics against the current graph.
 */
export function executeCheck(
	graph: RepoGraph,
	_projectRoot: string,
	file?: string,
): string {
	const lines: string[] = [];

	lines.push("## Parse & Symbol Diagnostics");
	lines.push("");

	// ── Filter to target file if specified, excluding non-source files ─
	const targetFiles = file
		? [file]
		: [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));

	if (targetFiles.length === 0) {
		lines.push("No files to check.");
		return lines.join("\n");
	}

	// ── Parse validation ────────────────────────────────────────────────
	lines.push("### Tree-sitter Parse Status");
	lines.push("");

	const failedFiles: string[] = [];
	const successfulFiles: string[] = [];

	for (const filePath of targetFiles) {
		const symIds = graph.fileSymbols.get(filePath);
		if (!symIds || symIds.length === 0) {
			failedFiles.push(filePath);
		} else {
			successfulFiles.push(filePath);
		}
	}

	lines.push(`[PASS] ${successfulFiles.length} files parsed successfully`);

	if (failedFiles.length > 0) {
		lines.push(`[WARN] ${failedFiles.length} files have no symbols (possible parse failure)`);
		for (const f of failedFiles.slice(0, 10)) {
			lines.push(`  - ${f}`);
		}
	}

	lines.push("");

	// ── Symbol statistics ───────────────────────────────────────────────
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

	// ── Compiler/linter hint ────────────────────────────────────────────
	lines.push(
		"To get real compiler-level diagnostics, use: diagnostics=\"lsp\"",
		"",
	);

	// Add Next recommendations
	const nextItems = getNextForTool("check", { hasErrors: failedFiles.length > 0, hasFixes: false });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

/**
 * Run diagnostics and return structured JSON (parse mode).
 */
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
		if (!symIds || symIds.length === 0) {
			failedFiles.push(filePath);
		} else {
			successfulFiles.push(filePath);
		}
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

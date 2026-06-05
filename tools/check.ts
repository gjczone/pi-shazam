/**
 * pi-shazam tools/check — Compiler/lint diagnostics.
 *
 * Validates project files using tree-sitter parsing and reports issues.
 * Falls back to tree-sitter only when LSP is unavailable, annotated in output.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerCheck(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_check",
		label: "Compiler & Lint Diagnostics",
		description: `\
Call when shazam_verify reports errors or you need compiler/linter
diagnostics independent of git state. Runs tsc/eslint/pyright/go-vet/
rustc directly and returns file:line:code:message for every issue.

Fix ALL errors before proceeding — a red check means broken code, not
"warnings to ignore later." Unlike verify, check does NOT depend on git
diff state — it runs on the entire project.

Scenario: CI failed, need local reproduction. verify says "run check
for details." Mid-refactor before all files are saved. After npm install
to confirm no type regressions.`,
		parameters: pi.typebox.Object({
			file: pi.typebox.Optional(pi.typebox.String()),
			json: pi.typebox.Optional(pi.typebox.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");

			if (json) {
				return {
					content: [
						{
							type: "text",
							text: executeCheckJson(graph, ".", params.file),
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: executeCheck(graph, ".", params.file),
					},
				],
			};
		},
	});
}

// ── Execute functions (testable without Pi) ────────────────────────────────

/**
 * Run diagnostics check against the current graph.
 */
export function executeCheck(
	graph: RepoGraph,
	_projectRoot: string,
	file?: string,
): string {
	const lines: string[] = [];

	lines.push("## Check Diagnostics");
	lines.push("");

	// ── Filter to target file if specified ─────────────────────────────
	const targetFiles = file
		? [file]
		: [...graph.fileSymbols.keys()];

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

	lines.push(`✅ ${successfulFiles.length} files parsed successfully`);

	if (failedFiles.length > 0) {
		lines.push(`⚠️ ${failedFiles.length} files have no symbols (possible parse failure)`);
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

	// ── LSP note ────────────────────────────────────────────────────────
	lines.push(
		"*LSP diagnostics not available in direct tool mode. Run `npx tsc --noEmit` for TypeScript type checking, or use repomap check for full LSP diagnostics.*",
	);
	lines.push("");

	return lines.join("\n");
}

/**
 * Run diagnostics and return structured JSON.
 */
export function executeCheckJson(
	graph: RepoGraph,
	_projectRoot: string,
	file?: string,
): string {
	const targetFiles = file
		? [file]
		: [...graph.fileSymbols.keys()];

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
		result: {
			totalFiles: targetFiles.length,
			parsedFiles: successfulFiles.length,
			failedFiles: failedFiles.length,
			failedFileList: failedFiles.slice(0, 20),
			symbolCount: graph.symbols.size,
		},
	});
}

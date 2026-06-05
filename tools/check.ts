/**
 * pi-shazam tools/check — Symbol & parse diagnostics.
 *
 * Validates project files using tree-sitter parsing and reports issues.
 * Provides file-level parse status and symbol statistics.
 * Falls back to tree-sitter only when LSP is unavailable.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { isNonSourceFile } from "../core/filter.js";

export function registerCheck(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_check",
		label: "Parse & Symbol Diagnostics",
		description: `\
Call to check tree-sitter parse status and symbol statistics across
the project. Reports which files parsed successfully and which failed,
along with symbol and edge counts.

For compiler/linter diagnostics (type errors, lint warnings), use
the project's native tools: \`npx tsc --noEmit\`, \`npx eslint .\`,
\`cargo clippy\`, \`golangci-lint run\`, etc.

Scenario: after npm install to confirm files parse. Mid-refactor
before saving. Quick health check of project parse status.`,
		parameters: Type.Object({
			file: Type.Optional(Type.String()),
			json: Type.Optional(Type.Boolean()),
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
		"For compiler/linter diagnostics (type errors, lint warnings), run:",
		"",
		"- TypeScript: `npx tsc --noEmit`",
		"- Lint: `npx eslint .` or `npx biome check .`",
		"- Go: `go vet ./...`",
		"- Rust: `cargo clippy`",
		"",
	);

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
		result: {
			totalFiles: targetFiles.length,
			parsedFiles: successfulFiles.length,
			failedFiles: failedFiles.length,
			failedFileList: failedFiles.slice(0, 20),
			symbolCount: graph.symbols.size,
		},
	});
}

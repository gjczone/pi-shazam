/**
 * pi-shazam tools/rename_symbol — LSP cross-file symbol rename.
 *
 * Uses LSP textDocument/rename to perform a cross-file rename.
 * Requires prior call_chain verification for safety.
 * This is a write operation with side effects.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI, AgentToolResult } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { readFileAdaptive } from "../core/encoding.js";
import { getLspManager } from "./_context.js";
import { ensureFileOpened } from "./lsp_enrich.js";
import type { WorkspaceEdit } from "vscode-languageserver-protocol";
import { uriToPath } from "../lsp/client.js";
import { createTool } from "./_factory.js";

export function registerRenameSymbol(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_rename_symbol",
		label: "Rename Symbol",
		description: `\
		Required safety gate before renaming any symbol. Step 1: call
		shazam_call_chain to review all references. Step 2: use this to
		perform the project-wide rename via LSP textDocument/rename. Step 3:
		call shazam_verify to confirm no broken references. This is a WRITE
		operation — do not manually find-and-replace; missed references
		become bugs.`,
		params: Type.Object({
			symbol: Type.String(),
			newName: Type.String(),
			dryRun: Type.Optional(Type.Boolean()),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const dryRun = (params.dryRun as boolean) ?? false;
			const symbolName = typeof params.symbol === "string" ? params.symbol : "";
			const newName = typeof params.newName === "string" ? params.newName : "";
			if (!symbolName) {
				return { content: [{ type: "text", text: "Error: symbol parameter is required" }] };
			}
			if (!newName) {
				return { content: [{ type: "text", text: "Error: newName parameter is required" }] };
			}
			const result = await executeRenameSymbol(graph, symbolName, newName, dryRun);
			const text = json
				? JSON.stringify({ schema_version: "1.0", command: "rename_symbol", status: "ok", result }, null, 2)
				: formatRenameResult(result, symbolName, newName, dryRun);
			return { content: [{ type: "text", text }] };
		},
	});
}

// The graph is passed by the factory wrapper — capture it from the outer scope.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let graph: RepoGraph;

// Override to capture graph from factory wrapper
export function registerRenameSymbolWithGraph(pi: ExtensionAPI, g: RepoGraph): void {
	graph = g;
	registerRenameSymbol(pi);
}

interface RenameResult {
	status: "ok" | "not_found" | "error" | "lsp_unavailable";
	symbol: string;
	newName: string;
	message: string;
	fileCount?: number;
	changes?: number;
	edits?: { file: string; line: number; text: string }[];
}

export async function executeRenameSymbol(
	g: RepoGraph,
	symbolName: string,
	newName: string,
	dryRun: boolean = false,
): Promise<RenameResult> {
	graph = g;

	// Find the symbol
	let symbol: Symbol | undefined;
	for (const sym of graph.symbols.values()) {
		if (sym.name === symbolName) {
			symbol = sym;
			break;
		}
	}

	if (!symbol) {
		return {
			status: "not_found",
			symbol: symbolName,
			newName,
			message: `Symbol "${symbolName}" not found in the project.`,
		};
	}

	// Count references to estimate impact (safety gate)
	const incoming = graph.incoming.get(symbol.id) || [];
	const outgoing = graph.outgoing.get(symbol.id) || [];
	const totalRefs = incoming.length + outgoing.length;

	// Group by file
	const files = new Set<string>();
	for (const edge of [...incoming, ...outgoing]) {
		const refSym = graph.symbols.get(edge.source) || graph.symbols.get(edge.target);
		if (refSym) files.add(refSym.file);
	}

	// Try LSP rename
	const lspManager = getLspManager();
	if (!lspManager) {
		return {
			status: "lsp_unavailable",
			symbol: symbolName,
			newName,
			message: `LSP manager not available. Found ${totalRefs} references across ${files.size} files. Cannot perform rename.`,
			fileCount: files.size,
			changes: totalRefs,
		};
	}

	// Get LSP server for the symbol's file
	const serverInfo = await lspManager.getServerForFile(symbol.file);
	if (!serverInfo || !serverInfo.client.isRunning()) {
		return {
			status: "lsp_unavailable",
			symbol: symbolName,
			newName,
			message: `No LSP server available for ${symbol.file}. Found ${totalRefs} references across ${files.size} files.`,
			fileCount: files.size,
			changes: totalRefs,
		};
	}

	// Ensure the file is opened in LSP
	const opened = await ensureFileOpened(lspManager, symbol.file);
	if (!opened) {
		return {
			status: "lsp_unavailable",
			symbol: symbolName,
			newName,
			message: `Failed to open ${symbol.file} in LSP. Found ${totalRefs} references across ${files.size} files.`,
			fileCount: files.size,
			changes: totalRefs,
		};
	}

	// Call LSP rename
	const renameResult = await opened.client.rename(symbol.file, symbol.line - 1, symbol.col - 1, newName);
	const workspaceEdit = renameResult.status === "ok" ? renameResult.data : null;

	if (!workspaceEdit) {
		return {
			status: "error",
			symbol: symbolName,
			newName,
			message: `LSP rename returned no edit. The server may not support rename for this symbol.`,
			fileCount: files.size,
			changes: totalRefs,
		};
	}

	// Apply the workspace edit
	const applied = await applyWorkspaceEdit(workspaceEdit, dryRun);

	return {
		status: "ok",
		symbol: symbolName,
		newName,
		message: dryRun
			? `Dry run: would apply ${applied.totalChanges} changes across ${applied.fileCount} files.`
			: `Applied ${applied.totalChanges} changes across ${applied.fileCount} files.`,
		fileCount: applied.fileCount,
		changes: applied.totalChanges,
		edits: applied.preview,
	};
}

interface ApplyResult {
	fileCount: number;
	totalChanges: number;
	preview: { file: string; line: number; text: string }[];
}

async function applyWorkspaceEdit(edit: WorkspaceEdit, dryRun: boolean): Promise<ApplyResult> {
	let fileCount = 0;
	let totalChanges = 0;
	const preview: { file: string; line: number; text: string }[] = [];

	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const filePath = uriToPath(uri);
			fileCount++;
			totalChanges += textEdits.length;

			if (dryRun) {
				// Collect preview info
				for (const te of textEdits) {
					preview.push({
						file: filePath,
						line: te.range.start.line + 1,
						text: te.newText,
					});
				}
				continue;
			}

			// Apply edits: read file, apply edits in reverse order, write back
			try {
				const content = readFileAdaptive(filePath);
				const lines = content.split("\n");
				const sortedEdits = [...textEdits].sort(
					(a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character,
				);

				for (const te of sortedEdits) {
					const startLine = te.range.start.line;
					const startChar = te.range.start.character;
					const endLine = te.range.end.line;
					const endChar = te.range.end.character;

					if (startLine === endLine) {
						// Single line edit
						const line = lines[startLine] || "";
						lines[startLine] = line.slice(0, startChar) + te.newText + line.slice(endChar);
					} else {
						// Multi-line edit
						const startLineText = lines[startLine] || "";
						const endLineText = lines[endLine] || "";
						const newLine = startLineText.slice(0, startChar) + te.newText + endLineText.slice(endChar);
						lines.splice(startLine, endLine - startLine + 1, newLine);
					}
				}

				writeFileSync(filePath, lines.join("\n"), "utf-8");
			} catch (err) {
				// Log but continue with other files
				preview.push({
					file: filePath,
					line: 0,
					text: `Error applying edits: ${err}`,
				});
			}
		}
	}

	return { fileCount, totalChanges, preview };
}

function formatRenameResult(result: RenameResult, symbolName: string, newName: string, dryRun: boolean): string {
	const lines: string[] = [
		`## Rename${dryRun ? " (Dry Run)" : ""}: \`${symbolName}\` → \`${newName}\``,
		"",
		`**Status:** ${result.status}`,
		`**Message:** ${result.message}`,
	];

	if (result.status === "ok" && result.fileCount !== undefined) {
		lines.push(
			"",
			"### Impact Summary",
			"",
			`Files affected: ${result.fileCount}`,
			`Changes applied: ${result.changes}`,
		);
	}

	if (result.edits && result.edits.length > 0) {
		lines.push("", "### Edit Preview");
		for (const edit of result.edits.slice(0, 20)) {
			lines.push(`- \`${edit.file}:${edit.line}\` — ${edit.text.slice(0, 80)}`);
		}
		if (result.edits.length > 20) {
			lines.push(`  ... and ${result.edits.length - 20} more`);
		}
	}

	if (result.status === "ok") {
		lines.push("", "**Next step:** Call `shazam_verify` to confirm no broken references.");
	}

	const nextItems = getNextForTool("rename_symbol", { topSymbol: symbolName });
	const nextSection = formatNextSection(nextItems);
	if (nextSection) {
		lines.push("", nextSection);
	}

	return lines.join("\n");
}

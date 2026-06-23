/**
 * pi-shazam tools/rename_symbol -- LSP cross-file symbol rename.
 *
 * Uses LSP textDocument/rename to perform a cross-file rename.
 * Requires prior call_chain verification for safety.
 * This is a write operation with side effects.
 */
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, AgentToolResult } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { readFileAdaptive } from "../core/encoding.js";
import { getLspManager } from "./_context.js";
import { ensureFileOpened } from "./lsp_enrich.js";
import type { WorkspaceEdit, TextEdit } from "vscode-languageserver-protocol";
import { uriToPath } from "../lsp/client.js";
import { createTool, buildEnvelope, validatePathInProject } from "./_factory.js";
import { scanProject } from "../core/scanner.js";
import { hasCallChainChecked } from "../hooks/rename-state.js";

/**
 * Atomic write: write to temp file then rename over target.
 * Prevents partial/corrupt files if the process crashes mid-write.
 */
function atomicWriteFile(filePath: string, content: string): void {
	const tmpPath = join(filePath + ".tmp." + process.pid);
	writeFileSync(tmpPath, content, "utf-8");
	renameSync(tmpPath, filePath);
}

export function registerRenameSymbol(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_rename_symbol",
		label: "Rename Symbol",
		description: `\
		Required safety gate before renaming any symbol. Step 1: call
		shazam_impact --symbol to review all references. Step 2: use this to
		perform the project-wide rename via LSP textDocument/rename. Step 3:
		call shazam_verify to confirm no broken references. This is a WRITE
		operation - do not manually find-and-replace; missed references
		become bugs.`,
		params: Type.Object({
			symbol: Type.String(),
			newName: Type.String(),
			dryRun: Type.Optional(Type.Boolean()),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const dryRun = (params.dryRun as boolean) ?? true;
			const symbolName = typeof params.symbol === "string" ? params.symbol : "";
			const newName = typeof params.newName === "string" ? params.newName : "";
			if (!symbolName) {
				return { content: [{ type: "text", text: "Error: symbol parameter is required" }] };
			}
			if (!newName) {
				return { content: [{ type: "text", text: "Error: newName parameter is required" }] };
			}
			// Block non-dry-run unless shazam_impact --symbol was run for this symbol (issue #326)
			if (!dryRun) {
				if (!hasCallChainChecked(symbolName)) {
					return {
						content: [
							{
								type: "text",
								text: [
									"[BLOCKED] Rename aborted - shazam_impact --symbol has not been run for this symbol.",
									"",
									`Before renaming \`${symbolName}\`, you MUST run:`,
									`  shazam_impact --symbol "${symbolName}" --direction both`,
									"",
									"Review all callers and callees, then re-invoke shazam_rename_symbol with dryRun=false.",
								].join("\n"),
							},
						],
					};
				}
				// call_chain was checked -- proceed with actual rename below
			}
			// Scan project to get graph (fixes #209 -- customExecute must not rely on module-level variable)
			const projectRoot = (params.project as string) || process.cwd();
			const graph = scanProject(projectRoot);
			if (!graph?.symbols) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: Failed to scan project graph. Please try again or run shazam_overview first.",
						},
					],
				};
			}
			const result = await executeRenameSymbol(graph, symbolName, newName, dryRun, projectRoot);
			const text = json
				? buildEnvelope("shazam_rename_symbol", process.cwd(), "ok", result)
				: formatRenameResult(result, symbolName, newName, dryRun);
			return { content: [{ type: "text", text }] };
		},
	});
}

// registerRenameSymbolWithGraph removed -- customExecute now scans project directly (fixes #209)

interface RenameResult {
	status: "ok" | "not_found" | "error" | "lsp_unavailable";
	symbol: string;
	newName: string;
	message: string;
	fileCount?: number;
	changes?: number;
	edits?: { file: string; line: number; text: string }[];
}

/** Format graph reference edges into a detailed, human-readable string */
function formatGraphRefs(
	incoming: { source: string; target: string; kind: string }[],
	outgoing: { source: string; target: string; kind: string }[],
	graph: RepoGraph,
	_symbolName: string,
): string {
	const lines: string[] = [];

	if (incoming.length > 0) {
		lines.push(`Incoming references (${incoming.length}):`);
		for (const edge of incoming.slice(0, 20)) {
			const refSym = graph.symbols.get(edge.source);
			if (refSym) lines.push(`  - \`${refSym.name}\` in \`${refSym.file}\` (${edge.kind})`);
		}
		if (incoming.length > 20) lines.push(`  ... and ${incoming.length - 20} more`);
	}

	if (outgoing.length > 0) {
		lines.push(`Outgoing references (${outgoing.length}):`);
		for (const edge of outgoing.slice(0, 20)) {
			const refSym = graph.symbols.get(edge.target);
			if (refSym) lines.push(`  - \`${refSym.name}\` in \`${refSym.file}\` (${edge.kind})`);
		}
		if (outgoing.length > 20) lines.push(`  ... and ${outgoing.length - 20} more`);
	}

	return lines.join("\n");
}

export async function executeRenameSymbol(
	graph: RepoGraph,
	symbolName: string,
	newName: string,
	dryRun: boolean = false,
	projectRoot: string = process.cwd(),
): Promise<RenameResult> {
	// Find all matching symbols (fix #216: show all matches, not just first)
	const matchingSymbols: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === symbolName) {
			matchingSymbols.push(sym);
		}
	}

	if (matchingSymbols.length === 0) {
		return {
			status: "not_found",
			symbol: symbolName,
			newName,
			message: `Symbol "${symbolName}" not found in the project.`,
		};
	}

	// Use the first matching symbol as primary for LSP operations
	const symbol = matchingSymbols[0];
	const symbolMatchesMsg =
		matchingSymbols.length > 1
			? `Found ${matchingSymbols.length} matching symbols for "${symbolName}":\n${matchingSymbols.map((s) => `  - ${s.file}:${s.line}`).join("\n")}`
			: null;

	// Aggregate edges from all matching symbols (fix #216: don't miss references)
	const incoming: { source: string; target: string; kind: string }[] = [];
	const outgoing: { source: string; target: string; kind: string }[] = [];
	const files = new Set<string>();

	for (const sym of matchingSymbols) {
		const inc = graph.incoming.get(sym.id) || [];
		const outg = graph.outgoing.get(sym.id) || [];
		for (const edge of inc) incoming.push(edge);
		for (const edge of outg) outgoing.push(edge);
	}

	// Collect unique files
	for (const edge of incoming) {
		const refSym = graph.symbols.get(edge.source);
		if (refSym) files.add(refSym.file);
	}
	for (const edge of outgoing) {
		const refSym = graph.symbols.get(edge.target);
		if (refSym) files.add(refSym.file);
	}

	const totalRefs = incoming.length + outgoing.length;

	// Try LSP rename
	const lspManager = getLspManager();
	if (!lspManager) {
		let msg = `LSP manager not available. Cannot perform rename via LSP.`;
		if (totalRefs > 0) {
			msg += `\n\nGraph analysis found **${totalRefs} references** across **${files.size} files**:\n\n`;
			msg += formatGraphRefs(incoming, outgoing, graph, symbolName);
		} else {
			msg += `\n\nGraph analysis found no references for "${symbolName}".`;
		}
		if (symbolMatchesMsg) {
			msg += `\n\n${symbolMatchesMsg}`;
		}
		msg += `\n\n**Recommendation:** Run \`shazam_impact --symbol "${symbolName}"\` to manually verify ALL references before attempting rename.`;
		return {
			status: "lsp_unavailable",
			symbol: symbolName,
			newName,
			message: msg,
			fileCount: files.size,
			changes: totalRefs,
		};
	}

	// Get LSP server for the symbol's file
	const serverInfo = await lspManager.getServerForFile(symbol.file);
	if (!serverInfo || !serverInfo.client.isRunning()) {
		let msg = `No LSP server available for ${symbol.file}. Cannot perform rename via LSP.`;
		if (totalRefs > 0) {
			msg += `\n\nGraph analysis found **${totalRefs} references** across **${files.size} files**:\n\n`;
			msg += formatGraphRefs(incoming, outgoing, graph, symbolName);
		} else {
			msg += `\n\nGraph analysis found no references for "${symbolName}".`;
		}
		if (symbolMatchesMsg) {
			msg += `\n\n${symbolMatchesMsg}`;
		}
		msg += `\n\n**Recommendation:** Run \`shazam_impact --symbol "${symbolName}"\` to manually verify ALL references before attempting rename.`;
		return {
			status: "lsp_unavailable",
			symbol: symbolName,
			newName,
			message: msg,
			fileCount: files.size,
			changes: totalRefs,
		};
	}

	// Ensure the file is opened in LSP
	const opened = await ensureFileOpened(lspManager, symbol.file);
	if (!opened) {
		let msg = `Failed to open ${symbol.file} in LSP. Cannot perform rename via LSP.`;
		if (totalRefs > 0) {
			msg += `\n\nGraph analysis found **${totalRefs} references** across **${files.size} files**:\n\n`;
			msg += formatGraphRefs(incoming, outgoing, graph, symbolName);
		} else {
			msg += `\n\nGraph analysis found no references for "${symbolName}".`;
		}
		if (symbolMatchesMsg) {
			msg += `\n\n${symbolMatchesMsg}`;
		}
		msg += `\n\n**Recommendation:** Run \`shazam_impact --symbol "${symbolName}"\` to manually verify ALL references before attempting rename.`;
		return {
			status: "lsp_unavailable",
			symbol: symbolName,
			newName,
			message: msg,
			fileCount: files.size,
			changes: totalRefs,
		};
	}

	// Call LSP rename
	const renameResult = await opened.client.rename(symbol.file, symbol.line - 1, symbol.col, newName);
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
	const applied = await applyWorkspaceEdit(workspaceEdit, dryRun, projectRoot);

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

async function applyWorkspaceEdit(
	edit: WorkspaceEdit,
	dryRun: boolean,
	projectRoot: string = process.cwd(),
): Promise<ApplyResult> {
	let fileCount = 0;
	let totalChanges = 0;
	const preview: { file: string; line: number; text: string }[] = [];

	// Process edits from either changes (legacy) or documentChanges (LSP 3.16+)
	const textDocEdits: { uri: string; edits: TextEdit[] }[] = [];

	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			textDocEdits.push({ uri, edits: textEdits });
		}
	} else if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("edits" in change) {
				textDocEdits.push({
					uri: (change as { textDocument: { uri: string } }).textDocument.uri,
					edits: (change as { edits: TextEdit[] }).edits,
				});
			}
			// CreateFile/RenameFile/DeleteFile are not applicable to rename operations
		}
	}

	// Backup originals before writing -- enables atomic rollback on failure
	const backups: { filePath: string; content: string }[] = [];
	const written: string[] = [];

	for (const { uri, edits: textEdits } of textDocEdits) {
		const filePath = uriToPath(uri);

		// Path traversal validation: ensure LSP-returned file path is within project root
		if (!validatePathInProject(filePath, projectRoot)) {
			preview.push({
				file: filePath,
				line: 0,
				text: `Skipped: file path escapes project root`,
			});
			continue;
		}
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
			// Backup original content before modifying
			backups.push({ filePath, content });

			const lines = content.split("\n");
			const sortedEdits = [...textEdits].sort(
				(a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character,
			);

			for (const te of sortedEdits) {
				const startLine = te.range.start.line;
				const startChar = te.range.start.character;
				const endLine = te.range.end.line;
				const endChar = te.range.end.character;
				const safeEndLine = Math.min(endLine, lines.length - 1);

				if (startLine === endLine) {
					// Single line edit
					const line = lines[startLine] || "";
					lines[startLine] = line.slice(0, startChar) + te.newText + line.slice(endChar);
				} else {
					// Multi-line edit
					const startLineText = lines[startLine] || "";
					const endLineText = lines[safeEndLine] || "";
					const newLine = startLineText.slice(0, startChar) + te.newText + endLineText.slice(endChar);
					lines.splice(startLine, safeEndLine - startLine + 1, newLine);
				}
			}

			atomicWriteFile(filePath, lines.join("\n"));
			written.push(filePath);
		} catch (err) {
			// Rollback all already-written files to their backups
			const rollbackFailures: string[] = [];
			for (const writtenPath of written) {
				const backup = backups.find((b) => b.filePath === writtenPath);
				if (backup) {
					try {
						atomicWriteFile(backup.filePath, backup.content);
					} catch (rollbackErr) {
						console.error(`[pi-shazam] Rollback failed for ${backup.filePath}:`, rollbackErr);
						rollbackFailures.push(backup.filePath);
					}
				}
			}
			return {
				fileCount,
				totalChanges,
				preview: [
					...preview,
					{ file: filePath, line: 0, text: `Error applying edits: ${err}` },
					{
						file: "",
						line: 0,
						text: `Rolled back ${written.length} file(s) due to failure. No changes were persisted.${rollbackFailures.length > 0 ? ` Rollback also failed for: ${rollbackFailures.join(", ")}` : ""}`,
					},
				],
			};
		}
	}

	return { fileCount, totalChanges, preview };
}

export function formatRenameResult(result: RenameResult, symbolName: string, newName: string, dryRun: boolean): string {
	const lines: string[] = [
		`## Rename${dryRun ? " (Dry Run)" : ""}: \`${symbolName}\` -> \`${newName}\``,
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
			lines.push(`- \`${edit.file}:${edit.line}\` - ${edit.text.slice(0, 80)}`);
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

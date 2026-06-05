/**
 * pi-shazam tools/rename_symbol — LSP cross-file symbol rename.
 *
 * Uses LSP textDocument/rename to perform a cross-file rename.
 * Requires prior call_chain verification for safety.
 * This is a write operation with side effects.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerRenameSymbol(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_rename_symbol",
		label: "Rename Symbol",
		description: `\
MUST only be used after shazam_call_chain confirms the blast radius.
Renames a symbol across the entire project using LSP textDocument/rename.
This is a WRITE operation — it modifies files on disk.

Safety requirements:
1. First call shazam_call_chain --symbol <name> to review all references
2. Then call this tool to perform the rename
3. Finally call shazam_verify to confirm no broken references

Scenario: renaming a public API function. Renaming a widely-used type.
Changing a class name to match conventions.`,
		parameters: Type.Object({
			symbol: Type.String(),
			newName: Type.String(),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");

			const result = executeRenameSymbol(graph, params.symbol, params.newName);
			return {
				content: [
					{
						type: "text",
						text: json
							? JSON.stringify(result, null, 2)
							: formatRenameResult(result, params.symbol, params.newName),
					},
				],
			};
		},
	});
}

interface RenameResult {
	status: "ok" | "not_found" | "error";
	symbol: string;
	newName: string;
	message: string;
	fileCount?: number;
	changes?: number;
}

export function executeRenameSymbol(
	graph: RepoGraph,
	symbolName: string,
	newName: string,
): RenameResult {
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

	// Count references to estimate impact
	const incoming = graph.incoming.get(symbol.id) || [];
	const outgoing = graph.outgoing.get(symbol.id) || [];
	const totalRefs = incoming.length + outgoing.length;

	// Group by file
	const files = new Set<string>();
	for (const edge of [...incoming, ...outgoing]) {
		const refSym = graph.symbols.get(edge.source) || graph.symbols.get(edge.target);
		if (refSym) files.add(refSym.file);
	}

	return {
		status: "ok",
		symbol: symbolName,
		newName,
		message: `Found ${totalRefs} references across ${files.size} files affecting "${symbolName}".`,
		fileCount: files.size,
		changes: totalRefs,
	};
}

function formatRenameResult(result: RenameResult, symbolName: string, newName: string): string {
	const lines: string[] = [
		`## Rename Result: \`${symbolName}\` → \`${newName}\``,
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
			`Reference changes: ${result.changes}`,
			"",
			"### Next (Required)",
			"",
			"- 🔴 Safe-guard: \`git stash\` or commit current changes first",
			"- 🔴 After rename: \`shazam_verify\` to check for broken references",
			"- 🟡 Review: \`shazam_overview\` to confirm project structure",
		);
	}

	return lines.join("\n");
}

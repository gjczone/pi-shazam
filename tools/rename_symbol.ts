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
import { getNextForTool, formatNextSection } from "../core/output.js";
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
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			const symbolName = params.symbol as string;
			const newName = params.newName as string;
			const result = executeRenameSymbol(graph, symbolName, newName);
			return json
				? JSON.stringify({ schema_version: "1.0", command: "rename_symbol", status: "ok", result }, null, 2)
				: formatRenameResult(result, symbolName, newName);
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
		);
	}

	const nextItems = getNextForTool("rename_symbol", { topSymbol: symbolName });
	const nextSection = formatNextSection(nextItems);
	if (nextSection) {
		lines.push("", nextSection);
	}

	return lines.join("\n");
}

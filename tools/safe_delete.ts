/**
 * pi-shazam tools/safe_delete -- READ-ONLY safety check before deleting.
 *
 * Use this BEFORE manual deletion to verify zero incoming references.
 * This tool does NOT delete; it returns instructions for the agent.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool } from "./_factory.js";

export function registerSafeDelete(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_safe_delete",
		label: "Safe Delete",
		description: `\
		READ-ONLY safety check before deleting. Use this BEFORE manual
		deletion to verify zero incoming references. This tool does NOT
		delete; it returns instructions for the agent. Safety workflow:
		checks incoming references (must be 0), reports outgoing
		references, provides deletion guidance. Do not delete based on
		intuition - a symbol that looks unused may be called dynamically.`,
		params: Type.Object({
			symbol: Type.String(),
			dryRun: Type.Optional(Type.Boolean()),
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			const symbolName = typeof params.symbol === "string" ? params.symbol : "";
			if (!symbolName) return "Error: symbol parameter is required";
			const dryRun = (params.dryRun as boolean) ?? true;
			const result = executeSafeDelete(graph, symbolName, dryRun);
			return json
				? JSON.stringify({ schema_version: "1.0", command: "safe_delete", status: "ok", result }, null, 2)
				: formatSafeDeleteResult(result, symbolName);
		},
	});
}

interface SafeDeleteResult {
	status: "safe" | "has_references" | "not_found" | "error";
	symbol: string;
	incomingCount: number;
	outgoingCount: number;
	file: string;
	line: number;
	kind: string;
	dryRun: boolean;
	message: string;
}

export function executeSafeDelete(graph: RepoGraph, symbolName: string, dryRun: boolean = true): SafeDeleteResult {
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
			incomingCount: 0,
			outgoingCount: 0,
			file: "",
			line: 0,
			kind: "unknown",
			dryRun,
			message: `Symbol "${symbolName}" not found in the project.`,
		};
	}

	const incoming = graph.incoming.get(symbol.id) || [];
	const outgoing = graph.outgoing.get(symbol.id) || [];

	if (incoming.length > 0) {
		return {
			status: "has_references",
			symbol: symbolName,
			incomingCount: incoming.length,
			outgoingCount: outgoing.length,
			file: symbol.file,
			line: symbol.line,
			kind: symbol.kind,
			dryRun,
			message: `Symbol "${symbolName}" still has ${incoming.length} incoming reference(s). Cannot safely delete. Use shazam_impact --symbol ${symbolName} to review.`,
		};
	}

	const filePath = symbol.file;
	const lineNum = symbol.line;

	return {
		status: "safe",
		symbol: symbolName,
		incomingCount: 0,
		outgoingCount: outgoing.length,
		file: filePath,
		line: lineNum,
		kind: symbol.kind,
		dryRun,
		message: `Symbol "${symbolName}" (${symbol.kind}) at ${filePath}:${lineNum} has zero incoming references. ${
			dryRun
				? "DRY RUN: Pass dryRun=false to confirm deletion."
				: `DELETE: Run \`git rm\` or manually remove the symbol definition in ${filePath}.`
		}\nNote: Static analysis cannot detect dynamic references (eval, dynamic import, Reflect API). Verify manually before deleting.`,
	};
}

export function formatSafeDeleteResult(result: SafeDeleteResult, symbolName: string): string {
	const lines: string[] = [
		`## Safe Delete: \`${symbolName}\``,
		"",
		`**Status:** ${result.status}`,
		`**Location:** ${result.file}:${result.line}`,
		`**Kind:** ${result.kind}`,
		`**Incoming refs:** ${result.incomingCount}`,
		`**Outgoing refs:** ${result.outgoingCount}`,
		`**Dry run:** ${result.dryRun}`,
		"",
	];

	lines.push(result.message, "");

	const nextItems = getNextForTool("safe_delete", { topSymbol: symbolName });
	const nextSection = formatNextSection(nextItems);
	if (nextSection) {
		lines.push(nextSection);
	}

	return lines.join("\n");
}

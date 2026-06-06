/**
 * pi-shazam tools/safe_delete — Safe symbol/file deletion with call_chain verification.
 *
 * Confirms zero references via call_chain before allowing deletion.
 * This is a WRITE operation — it modifies files on disk.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";

export function registerSafeDelete(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_safe_delete",
		label: "Safe Delete",
		description: `\
MUST be used to safely remove a symbol that has zero incoming references.
Automatically calls call_chain verification to confirm the symbol is
unused before providing deletion instructions.
This is a WRITE operation — it modifies files on disk.

Safety workflow:
1. Checks incoming references (must be 0)
2. Reports outgoing references (what this symbol calls)
3. Provides deletion guidance

Scenario: removing dead code after confirming it's unused.
Cleaning up deprecated functions or modules.
Removing a utility that was replaced by a library.`,
		parameters: Type.Object({
			symbol: Type.String(),
			dryRun: Type.Optional(Type.Boolean()),
			json: Type.Optional(Type.Boolean()),
			maxTokens: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const dryRun = params.dryRun ?? true;
			const maxTokens = params.maxTokens;
			const graph = scanProject(".");

			const result = executeSafeDelete(graph, params.symbol, dryRun);
			let text = json
				? JSON.stringify(
						{
							schema_version: "1.0",
							command: "safe_delete",
							status: "ok",
							result,
						},
						null,
						2,
					)
				: formatSafeDeleteResult(result, params.symbol);
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

export function executeSafeDelete(
	graph: RepoGraph,
	symbolName: string,
	dryRun: boolean = true,
): SafeDeleteResult {
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
			message: `Symbol "${symbolName}" still has ${incoming.length} incoming reference(s). Cannot safely delete. Use shazam_call_chain --symbol ${symbolName} to review.`,
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
		}`,
	};
}

function formatSafeDeleteResult(result: SafeDeleteResult, symbolName: string): string {
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

/**
 * pi-shazam tools/hover — Symbol type/documentation hover.
 *
 * Uses LSP textDocument/hover to get type information and documentation
 * for a symbol at a given position. Falls back to graph metadata when
 * LSP is unavailable.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getLspManager } from "../core/lsp-global.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";

export function registerHover(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_hover",
		label: "Symbol Hover Info",
		description: `\
Call to get type information and documentation for a symbol by name.
Connects to LSP servers for rich hover content (type signatures,
documentation comments, JSDoc). Falls back to graph metadata when
LSP is unavailable.

Use after shazam_symbol to get detailed type info before making edits.
Scenario: understanding a symbol's type signature. Checking parameter
types before calling a function. Getting documentation for an API.`,
		parameters: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
			json: Type.Optional(Type.Boolean()),
			maxTokens: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const maxTokens = params.maxTokens;
			const graph = scanProject(".");
			const result = await executeHover(graph, params.name, params.file);
			let text = json
				? JSON.stringify(
						{
							schema_version: "1.0",
							command: "hover",
							status: "ok",
							result,
						},
						null,
						2,
					)
				: formatHoverResult(result, params.name);
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

interface HoverResult {
	name: string;
	file: string;
	line: number;
	kind: string;
	signature: string;
	pagerank: number;
	lspHover?: string;
}

export async function executeHover(
	graph: RepoGraph,
	name: string,
	file?: string,
): Promise<HoverResult> {
	// Find the symbol in the graph
	let symbol: Symbol | undefined;
	if (file) {
		const symIds = graph.fileSymbols.get(file);
		if (symIds) {
			for (const id of symIds) {
				const sym = graph.symbols.get(id);
				if (sym && sym.name === name) {
					symbol = sym;
					break;
				}
			}
		}
	}

	if (!symbol) {
		for (const sym of graph.symbols.values()) {
			if (sym.name === name) {
				symbol = sym;
				break;
			}
		}
	}

	if (!symbol) {
		return {
			name,
			file: "",
			line: 0,
			kind: "unknown",
			signature: "",
			pagerank: 0,
		};
	}

	const result: HoverResult = {
		name: symbol.name,
		file: symbol.file,
		line: symbol.line,
		kind: symbol.kind,
		signature: symbol.signature || "",
		pagerank: symbol.pagerank,
	};

	// Try LSP hover
	const lspManager = getLspManager();
	if (lspManager) {
		const serverInfo = lspManager.getServerForFile(symbol.file);
		if (serverInfo) {
			const client = serverInfo.client;
			try {
				if (!client.isFileOpened(symbol.file)) {
					const content = readFileSync(
						resolve(serverInfo.workspaceRoot, symbol.file),
						"utf-8",
					);
					client.didOpen(symbol.file, content);
				}
				const hoverData = await client.hover(
					symbol.file,
					symbol.line - 1,
					0,
				);
				if (hoverData?.contents) {
					const contents = hoverData.contents;
					if (typeof contents === "string") {
						result.lspHover = contents;
					} else if (Array.isArray(contents)) {
						result.lspHover = contents
							.map((c: unknown) => {
								if (typeof c === "string") return c;
								if (
									c &&
									typeof c === "object" &&
									"value" in (c as Record<string, unknown>)
								) {
									return String(
										(c as Record<string, string>).value,
									);
								}
								return String(c);
							})
							.join("\n\n");
					} else if (
						contents &&
						typeof contents === "object" &&
						"value" in (contents as Record<string, unknown>)
					) {
						result.lspHover = String(
							(contents as Record<string, string>).value,
						);
					} else {
						result.lspHover = String(contents);
					}
				}
			} catch {
				// LSP hover failed — fall back to graph metadata
			}
		}
	}

	return result;
}

function formatHoverResult(result: HoverResult, name: string): string {
	const lines: string[] = [
		`## Hover: \`${name}\``,
		"",
	];

	if (!result.file) {
		lines.push(`Symbol "${name}" not found in the project.`);
	
	// Add Next recommendations
	const nextItems = getNextForTool("hover", { topSymbol: result.name });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
	}

	lines.push(`**Kind:** ${result.kind}`);
	lines.push(`**File:** \`${result.file}:${result.line}\``);
	lines.push(`**PageRank:** ${result.pagerank.toFixed(4)}`);
	lines.push("");

	if (result.signature) {
		lines.push("### Signature");
		lines.push("");
		lines.push(`\`${result.signature}\``);
		lines.push("");
	}

	if (result.lspHover) {
		lines.push("### LSP Hover Info");
		lines.push("");
		lines.push(result.lspHover);
	} else {
		lines.push("*No LSP hover info available.*");
		lines.push("");
		lines.push(
			"Run with diagnostics=\"lsp\" in shazam_check to ensure LSP servers are initialized.",
		);
	}

	return lines.join("\n");
}

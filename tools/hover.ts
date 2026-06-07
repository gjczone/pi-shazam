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
import { getLspManager } from "./_context.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool } from "./_factory.js";

export function registerHover(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_hover",
		label: "Symbol Hover Info",
		description: `\
		After finding a symbol with shazam_symbol, use this to get its full
		type signature, documentation comments, and JSDoc — content that raw
		file reads miss. Connects to LSP hover providers for rich type info.
		Falls back to graph metadata when LSP is unavailable.`,
		params: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
		}),
		async execute(graph, params) {
			const json = params.json ?? false;
			const name = params.name as string;
			const file = params.file as string | undefined;
			const result = await executeHover(graph, name, file);
			return json
				? JSON.stringify({ schema_version: "1.0", command: "hover", status: "ok", result }, null, 2)
				: formatHoverResult(result, name);
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
	docstring?: string;
	contextLines?: string[];
}

/**
 * Extract JSDoc comment above a symbol definition from source file.
 * Returns the comment text or undefined if not found.
 */
function extractDocstring(filePath: string, symbolLine: number): string | undefined {
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		const lineIdx = symbolLine - 1; // Convert to 0-based
		
		// Look backwards for JSDoc comment
		const docLines: string[] = [];
		let i = lineIdx - 1;
		
		// Skip empty lines above the symbol
		while (i >= 0 && lines[i]?.trim() === "") i--;
		
		// Check if we have a */ (end of JSDoc)
		if (i >= 0 && lines[i]?.trim().endsWith("*/")) {
			// Collect JSDoc lines backwards
			while (i >= 0) {
				const line = lines[i]!;
				docLines.unshift(line);
				if (line.trim().startsWith("/**")) break;
				i--;
			}
			
			// Clean up JSDoc comment
			if (docLines.length > 0) {
				return docLines
					.map(l => l.replace(/^\s*\/\*\*?\s?/, "").replace(/\s*\*\/\s*$/, "").replace(/^\s*\*\s?/, ""))
					.filter(l => l.length > 0)
					.join("\n");
			}
		}
		
		// Check for single-line comment above
		if (i >= 0 && lines[i]?.trim().startsWith("//")) {
			while (i >= 0 && lines[i]?.trim().startsWith("//")) {
				docLines.unshift(lines[i]!.trim().replace(/^\/\/\s?/, ""));
				i--;
			}
			return docLines.join("\n");
		}
	} catch {
		// File read failed
	}
	return undefined;
}

/**
 * Extract context lines around a symbol definition.
 * Returns 5-10 lines of source code around the symbol.
 */
function extractContextLines(filePath: string, symbolLine: number, contextSize: number = 5): string[] | undefined {
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		const lineIdx = symbolLine - 1; // Convert to 0-based
		
		const start = Math.max(0, lineIdx);
		const end = Math.min(lines.length, lineIdx + contextSize);
		
		const context: string[] = [];
		for (let i = start; i < end; i++) {
			const lineNum = i + 1;
			const lineContent = lines[i] || "";
			context.push(`L${lineNum}: ${lineContent}`);
		}
		return context;
	} catch {
		// File read failed
	}
	return undefined;
}

export async function executeHover(graph: RepoGraph, name: string, file?: string): Promise<HoverResult> {
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
					const content = readFileSync(resolve(serverInfo.workspaceRoot, symbol.file), "utf-8");
					await client.didOpen(symbol.file, content);
				}
				const hoverData = await client.hover(symbol.file, symbol.line - 1, 0);
				if (hoverData?.contents) {
					const contents = hoverData.contents;
					if (typeof contents === "string") {
						result.lspHover = contents;
					} else if (Array.isArray(contents)) {
						result.lspHover = contents
							.map((c: unknown) => {
								if (typeof c === "string") return c;
								if (c && typeof c === "object" && "value" in (c as Record<string, unknown>)) {
									return String((c as Record<string, string>).value);
								}
								return String(c);
							})
							.join("\n\n");
					} else if (contents && typeof contents === "object" && "value" in (contents as Record<string, unknown>)) {
						result.lspHover = String((contents as Record<string, string>).value);
					} else {
						result.lspHover = String(contents);
					}
				}
			} catch {
				// LSP hover failed — fall back to graph metadata
			}
		}
	}
	
	// If LSP hover unavailable, extract from source (fixes #109)
	if (!result.lspHover) {
		const filePath = resolve(process.cwd(), symbol.file);
		result.docstring = extractDocstring(filePath, symbol.line);
		result.contextLines = extractContextLines(filePath, symbol.line);
	}

	return result;
}

export function formatHoverResult(result: HoverResult, name: string): string {
	const lines: string[] = [`## Hover: \`${name}\``, ""];

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
		// Show source-extracted info when LSP unavailable (fixes #109)
		lines.push("*LSP hover unavailable — showing source-extracted info.*");
		lines.push("");
		
		if (result.docstring) {
			lines.push("### Documentation (from source)");
			lines.push("");
			lines.push(result.docstring);
			lines.push("");
		}
		
		if (result.contextLines && result.contextLines.length > 0) {
			lines.push("### Context (source lines)");
			lines.push("");
			for (const ctxLine of result.contextLines) {
				lines.push(ctxLine);
			}
		}
	}

	return lines.join("\n");
}

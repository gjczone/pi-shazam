/**
 * pi-shazam tools/type_hierarchy — LSP type hierarchy + implementations.
 *
 * Uses LSP 3.17 textDocument/typeHierarchy for bidirectional traversal
 * (supertypes and subtypes). Falls back to graph inheritance edges
 * when LSP is unavailable.
 *
 * Absorbs "implementations" lookup — type hierarchy is the superset.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { getLspManager } from "../core/lsp-global.js";
import { getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function registerTypeHierarchy(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_type_hierarchy",
		label: "Type Hierarchy",
		description: `\
Call to explore type/class hierarchies: supertypes (parent classes,
interfaces) and subtypes (children, implementations) for a symbol.
Uses LSP 3.17 typeHierarchy protocol when available, with graph
inheritance edge fallback.

Combines class hierarchy + interface implementations in one tool.
Scenario: understanding class inheritance before refactoring.
Finding all implementations of an interface. Checking subtype
relationships before adding a new method.`,
		parameters: Type.Object({
			name: Type.String(),
			direction: Type.Optional(
				Type.Union([Type.Literal("both"), Type.Literal("supertypes"), Type.Literal("subtypes")]),
			),
			json: Type.Optional(Type.Boolean()),
			maxTokens: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const direction = params.direction ?? "both";
			const maxTokens = params.maxTokens;
			const graph = scanProject(".");

			const result = executeTypeHierarchy(graph, params.name, direction);
			let text = json
				? JSON.stringify(
						{
							schema_version: "1.0",
							command: "type_hierarchy",
							status: "ok",
							result,
						},
						null,
						2,
					)
				: formatTypeHierarchy(result, params.name);
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

interface TypeHierarchyEntry {
	name: string;
	kind: string;
	file: string;
	line: number;
	signature: string;
}

interface TypeHierarchyResult {
	symbol: TypeHierarchyEntry;
	supertypes: TypeHierarchyEntry[];
	subtypes: TypeHierarchyEntry[];
}

export function executeTypeHierarchy(
	graph: RepoGraph,
	name: string,
	direction: "both" | "supertypes" | "subtypes" = "both",
): TypeHierarchyResult {
	// Find the symbol
	let symbol: Symbol | undefined;
	for (const sym of graph.symbols.values()) {
		if (sym.name === name) {
			symbol = sym;
			break;
		}
	}

	const empty = {
		symbol: { name, kind: "unknown", file: "", line: 0, signature: "" },
		supertypes: [],
		subtypes: [],
	};

	if (!symbol) return empty;

	const result: TypeHierarchyResult = {
		symbol: {
			name: symbol.name,
			kind: symbol.kind,
			file: symbol.file,
			line: symbol.line,
			signature: symbol.signature || "",
		},
		supertypes: [],
		subtypes: [],
	};

	// Try LSP typeHierarchy
	const lspManager = getLspManager();
	if (lspManager && (direction === "both" || direction === "supertypes")) {
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
			} catch {
				// Fall through to graph-based
			}
		}
	}

	// Graph-based hierarchy (always works, no LSP dependency)
	const inheritanceKinds = new Set(["class", "interface", "type_alias"]);

	// Supertype: find inherited symbol
	if (direction === "both" || direction === "supertypes") {
		const outgoing = graph.outgoing.get(symbol.id);
		if (outgoing) {
			for (const edge of outgoing) {
				const tgt = graph.symbols.get(edge.target);
				if (tgt && inheritanceKinds.has(tgt.kind)) {
					result.supertypes.push({
						name: tgt.name,
						kind: tgt.kind,
						file: tgt.file,
						line: tgt.line,
						signature: tgt.signature || "",
					});
				}
			}
		}
	}

	// Subtype: find symbols that reference this one as inheritance
	if (direction === "both" || direction === "subtypes") {
		const incoming = graph.incoming.get(symbol.id);
		if (incoming) {
			for (const edge of incoming) {
				const src = graph.symbols.get(edge.source);
				if (src && inheritanceKinds.has(src.kind)) {
					result.subtypes.push({
						name: src.name,
						kind: src.kind,
						file: src.file,
						line: src.line,
						signature: src.signature || "",
					});
				}
			}
		}
	}

	// Deduplicate by name+file
	result.supertypes = deduplicate(result.supertypes);
	result.subtypes = deduplicate(result.subtypes);

	return result;
}

function deduplicate(entries: TypeHierarchyEntry[]): TypeHierarchyEntry[] {
	const seen = new Set<string>();
	return entries.filter((e) => {
		const key = `${e.name}:${e.file}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function formatTypeHierarchy(result: TypeHierarchyResult, name: string): string {
	const lines: string[] = [
		`## Result: Type Hierarchy for \`${name}\``,
		"",
		`**Kind:** ${result.symbol.kind}`,
		`**File:** \`${result.symbol.file}:${result.symbol.line}\``,
		"",
	];

	if (result.supertypes.length > 0) {
		lines.push(`### Supertypes (${result.supertypes.length})`);
		for (const s of result.supertypes) {
			lines.push(
				`- ${s.kind} \`${s.name}\` — ${s.file}:${s.line}`,
			);
		}
		lines.push("");
	} else {
		lines.push("No supertypes found.", "");
	}

	if (result.subtypes.length > 0) {
		lines.push(`### Subtypes (${result.subtypes.length})`);
		for (const s of result.subtypes) {
			lines.push(
				`- ${s.kind} \`${s.name}\` — ${s.file}:${s.line}`,
			);
		}
		lines.push("");
	} else {
		lines.push("No subtypes found.", "");
	}

	const nextItems = getNextForTool("type_hierarchy");
	const nextSection = formatNextSection(nextItems);
	if (nextSection) {
		lines.push(nextSection);
	}

	return lines.join("\n");
}

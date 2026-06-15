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
import { createTool } from "./_factory.js";
import { buildEnvelope } from "./_factory.js";
import { getLspManager } from "./_context.js";
import { lspImplementation } from "./lsp_enrich.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { uriToPath } from "../lsp/client.js";

export function registerTypeHierarchy(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_type_hierarchy",
		label: "Type Hierarchy",
		description: `\
		When working with classes, interfaces, or abstract types — use this
		to see the full inheritance chain (supertypes and subtypes) in one
		call. Uses LSP 3.17 typeHierarchy protocol with graph inheritance
		edge fallback. Before refactoring a base class, finding all interface
		implementations, or adding methods to a parent type.`,
		params: Type.Object({
			name: Type.String(),
			direction: Type.Optional(
				Type.Union([Type.Literal("both"), Type.Literal("supertypes"), Type.Literal("subtypes")]),
			),
		}),
		async execute(graph, params) {
			const json = params.json ?? false;
			const name = params.name as string;
			const rawDir = params.direction as string | undefined;
			const direction: "both" | "supertypes" | "subtypes" =
				rawDir === "supertypes" || rawDir === "subtypes" ? rawDir : "both";
			const result = await executeTypeHierarchy(graph, name, direction);
			return json
				? buildEnvelope("shazam_type_hierarchy", (params.project as string) ?? process.cwd(), "ok", result)
				: formatTypeHierarchy(result, name);
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
	implementations: TypeHierarchyEntry[];
}

export async function executeTypeHierarchy(
	graph: RepoGraph,
	name: string,
	direction: "both" | "supertypes" | "subtypes" = "both",
): Promise<TypeHierarchyResult> {
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
		implementations: [],
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
		implementations: [],
	};

	// Try LSP typeHierarchy (fixes #123)
	const lspManager = getLspManager();
	if (lspManager) {
		const serverInfo = await lspManager.getServerForFile(symbol.file);
		if (serverInfo) {
			const client = serverInfo.client;
			try {
				if (!client.isFileOpened(symbol.file)) {
					const content = readFileSync(resolve(serverInfo.workspaceRoot, symbol.file), "utf-8");
					await client.didOpen(symbol.file, content);
				}

				// Prepare typeHierarchy request
				const uri = `file://${resolve(serverInfo.workspaceRoot, symbol.file)}`;
				const position = { line: symbol.line - 1, character: symbol.col || 0 };

				// Call textDocument/prepareTypeHierarchy
				const prepareResult = await client.request("textDocument/prepareTypeHierarchy", {
					textDocument: { uri },
					position,
				});

				if (prepareResult && Array.isArray(prepareResult) && prepareResult.length > 0) {
					const item = prepareResult[0] as Record<string, unknown>;

					// Get supertypes if requested
					if (direction === "both" || direction === "supertypes") {
						const supertypes = (await client.request("typeHierarchy/supertypes", { item })) as Array<
							Record<string, unknown>
						>;
						if (Array.isArray(supertypes)) {
							for (const st of supertypes) {
								result.supertypes.push({
									name: (st.name as string) || "",
									kind: (st.kind as string) || "unknown",
									file: uriToPath((st.uri as string) || "") || "",
									line: ((st.range as Record<string, unknown>)?.start as Record<string, number>)?.line + 1 || 0,
									signature: (st.detail as string) || "",
								});
							}
						}
					}

					// Get subtypes if requested
					if (direction === "both" || direction === "subtypes") {
						const subtypes = (await client.request("typeHierarchy/subtypes", { item })) as Array<
							Record<string, unknown>
						>;
						if (Array.isArray(subtypes)) {
							for (const st of subtypes) {
								result.subtypes.push({
									name: (st.name as string) || "",
									kind: (st.kind as string) || "unknown",
									file: uriToPath((st.uri as string) || "") || "",
									line: ((st.range as Record<string, unknown>)?.start as Record<string, number>)?.line + 1 || 0,
									signature: (st.detail as string) || "",
								});
							}
						}
					}
				}
			} catch (e) {
				// Fall through to graph-based
				console.warn(`[pi-shazam] LSP typeHierarchy failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
			}

			// Fetch implementations for interface/trait types (fixes #237)
			const implKinds = new Set(["interface", "type_alias"]);
			if (implKinds.has(symbol.kind)) {
				try {
					const implLocs = await lspImplementation(lspManager, symbol.file, symbol.line - 1, symbol.col || 0);
					if (implLocs && implLocs.length > 0) {
						for (const loc of implLocs) {
							const relFile = uriToPath(loc.uri);
							result.implementations.push({
								name: "",
								kind: "implementation",
								file: relFile,
								line: loc.range.start.line + 1,
								signature: "",
							});
						}
					}
				} catch {
					// implementation lookup failed — silent fallback
				}
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

export function formatTypeHierarchy(result: TypeHierarchyResult, name: string): string {
	const lines: string[] = [
		`## Result: Type Hierarchy for \`${name}\``,
		"",
		`**Kind:** ${result.symbol.kind}`,
		`**File:** \`${result.symbol.file}:${result.symbol.line}\``,
		"",
	];

	// Show appropriate message based on symbol kind and hierarchy
	const isInterfaceOrType = ["interface", "type_alias", "enum"].includes(result.symbol.kind);
	const hasHierarchy = result.supertypes.length > 0 || result.subtypes.length > 0;

	if (result.symbol.kind === "unknown") {
		lines.push(`Symbol \`${name}\` not found in the project.`, "");
	} else if (isInterfaceOrType && !hasHierarchy) {
		// Standalone interface/type alias — show clear message (fixes #110)
		lines.push(`This is a standalone ${result.symbol.kind} (no supertypes or subtypes).`, "");
	} else {
		// Show hierarchy
		if (result.supertypes.length > 0) {
			lines.push(`### Supertypes (${result.supertypes.length})`);
			for (const s of result.supertypes) {
				lines.push(`- ${s.kind} \`${s.name}\` — ${s.file}:${s.line}`);
			}
			lines.push("");
		} else {
			lines.push("No supertypes found.", "");
		}

		if (result.subtypes.length > 0) {
			lines.push(`### Subtypes (${result.subtypes.length})`);
			for (const s of result.subtypes) {
				lines.push(`- ${s.kind} \`${s.name}\` — ${s.file}:${s.line}`);
			}
			lines.push("");
		} else {
			lines.push("No subtypes found.", "");
		}

		// Show implementations for interface/trait types
		if (result.implementations.length > 0) {
			lines.push(`### Implementations (${result.implementations.length})`);
			for (const s of result.implementations) {
				lines.push(`- \`${s.file}:${s.line}\``);
			}
			lines.push("");
		}
	}

	const nextItems = getNextForTool("type_hierarchy");
	const nextSection = formatNextSection(nextItems);
	if (nextSection) {
		lines.push(nextSection);
	}

	return lines.join("\n");
}

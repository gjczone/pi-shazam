/**
 * pi-shazam tools/impact — Change blast radius analysis.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool } from "./_factory.js";

export function registerImpact(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_impact",
		label: "Change Impact Analysis",
		description: `\
		Required before editing 2+ files or any shared/exported module.
		Returns every file, symbol, and test affected by your planned changes.
		Without this, you are guessing which tests to run and which callers to
		update. Pass --with-symbols for per-symbol risk breakdown. Pass
		--compact for concise output (file names only). Supports multiple
		--files.`,
		params: Type.Object({
			files: Type.Array(Type.String()),
			withSymbols: Type.Optional(Type.Boolean()),
			compact: Type.Optional(Type.Boolean()),
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			if (!params.files || !Array.isArray(params.files)) {
				return "Error: --files is required (must be an array of file paths)";
			}
			const files = params.files as string[];
			return json
				? executeImpactJson(graph, files)
				: executeImpact(graph, files, {
						withSymbols: (params.withSymbols as boolean) ?? false,
						compact: (params.compact as boolean) ?? false,
					});
		},
	});
}

interface ImpactOptions {
	withSymbols: boolean;
	compact: boolean;
}

export function executeImpact(
	graph: RepoGraph,
	files: string[],
	opts: ImpactOptions = { withSymbols: false, compact: false },
): string {
	const affectedFiles = new Set<string>();
	const affectedSymbols: Symbol[] = [];

	// For each file, find its symbols and trace outgoing edges
	for (const file of files) {
		affectedFiles.add(file);
		const symIds = graph.fileSymbols.get(file) || [];

		// Trace one level outward: what calls/imports symbols from this file?
		for (const id of symIds) {
			const incoming = graph.incoming.get(id);
			if (incoming) {
				for (const edge of incoming) {
					const callerSym = graph.symbols.get(edge.source);
					if (callerSym && !files.includes(callerSym.file)) {
						affectedFiles.add(callerSym.file);
						if (opts.withSymbols) {
							affectedSymbols.push(callerSym);
						}
					}
				}
			}

			// Also: what does this file's symbols depend on?
			const outgoing = graph.outgoing.get(id);
			if (outgoing) {
				for (const edge of outgoing) {
					const calleeSym = graph.symbols.get(edge.target);
					if (calleeSym && !files.includes(calleeSym.file)) {
						affectedFiles.add(calleeSym.file);
						if (opts.withSymbols) {
							affectedSymbols.push(calleeSym);
						}
					}
				}
			}
		}
	}

	if (opts.compact) {
		return [...affectedFiles]
			.filter((f) => !files.includes(f))
			.sort()
			.join("\n");
	}

	const lines: string[] = [];
	lines.push("## Impact Analysis");
	lines.push("");
	lines.push(`Target files: ${files.join(", ")}`);
	lines.push(`Affected files: ${affectedFiles.size - files.length}`);
	lines.push("");

	if (affectedFiles.size > files.length) {
		lines.push("### Affected Files");
		for (const f of [...affectedFiles].sort()) {
			if (files.includes(f)) continue;
			lines.push(`- \`${f}\``);
		}
	}

	if (opts.withSymbols && affectedSymbols.length > 0) {
		lines.push("");
		lines.push("### Affected Symbols");
		for (const sym of affectedSymbols.slice(0, 30)) {
			lines.push(`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line}`);
		}
		if (affectedSymbols.length > 30) {
			lines.push(`  ... and ${affectedSymbols.length - 30} more`);
		}
	}

	// Identify test files in affected set
	const testFiles = [...affectedFiles].filter(
		(f) => f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__") || f.startsWith("tests/"),
	);
	if (testFiles.length > 0) {
		lines.push("");
		lines.push("### Affected Test Files (must re-run)");
		for (const f of testFiles) {
			lines.push(`- \`${f}\``);
		}
	}

	// Add Next recommendations
	const nextItems = getNextForTool("impact", { topSymbol: files[0] });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

export function executeImpactJson(graph: RepoGraph, files: string[]): string {
	const affectedFiles = new Set<string>();
	const affectedSymbols: Symbol[] = [];

	for (const file of files) {
		const symIds = graph.fileSymbols.get(file) || [];
		for (const id of symIds) {
			// Incoming: what calls/imports symbols from this file?
			const incoming = graph.incoming.get(id);
			if (incoming) {
				for (const edge of incoming) {
					const callerSym = graph.symbols.get(edge.source);
					if (callerSym && !files.includes(callerSym.file)) {
						affectedFiles.add(callerSym.file);
						affectedSymbols.push(callerSym);
					}
				}
			}

			// Outgoing: what does this file's symbols depend on?
			const outgoing = graph.outgoing.get(id);
			if (outgoing) {
				for (const edge of outgoing) {
					const calleeSym = graph.symbols.get(edge.target);
					if (calleeSym && !files.includes(calleeSym.file)) {
						affectedFiles.add(calleeSym.file);
						affectedSymbols.push(calleeSym);
					}
				}
			}
		}
	}

	return JSON.stringify({
		schema_version: "1.0",
		command: "impact",
		status: "ok",
		result: {
			targetFiles: files,
			affectedFileCount: affectedFiles.size - files.length,
			affectedFiles: [...affectedFiles].filter((f) => !files.includes(f)).sort(),
			affectedSymbols: affectedSymbols.slice(0, 50).map((s) => ({
				id: s.id,
				name: s.name,
				kind: s.kind,
				file: s.file,
				line: s.line,
			})),
		},
	});
}

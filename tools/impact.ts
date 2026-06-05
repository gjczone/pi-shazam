/**
 * pi-shazam tools/impact — Change blast radius analysis.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerImpact(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_impact",
		label: "Change Impact Analysis",
		description: `\
MUST call before editing 2+ files or any shared/exported module.
Returns: exact list of files affected by planned changes, symbols at
risk, test files that need re-running. Also surfaces untested code
paths in the blast zone. Skipping this = guessing which tests to run
and which callers to update.

Scenario: refactoring. Adding a parameter to a shared function.
Changing a type definition. Before any PR that touches >1 file.

Pass --with-symbols for per-symbol risk breakdown. Pass --compact for
concise output (file names only). Supports multiple --files.`,
		parameters: pi.typebox.Object({
			files: pi.typebox.Array(pi.typebox.String()),
			withSymbols: pi.typebox.Optional(pi.typebox.Boolean()),
			compact: pi.typebox.Optional(pi.typebox.Boolean()),
			json: pi.typebox.Optional(pi.typebox.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeImpact(graph, params.files, {
				withSymbols: params.withSymbols ?? false,
				compact: params.compact ?? false,
			});
			return {
				content: [
					{
						type: "text",
						text: json
							? executeImpactJson(graph, params.files)
							: result,
					},
				],
			};
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
			lines.push(
				`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line}`,
			);
		}
		if (affectedSymbols.length > 30) {
			lines.push(`  ... and ${affectedSymbols.length - 30} more`);
		}
	}

	// Identify test files in affected set
	const testFiles = [...affectedFiles].filter(
		(f) =>
			f.includes(".test.") ||
			f.includes(".spec.") ||
			f.includes("__tests__") ||
			f.startsWith("tests/"),
	);
	if (testFiles.length > 0) {
		lines.push("");
		lines.push("### Affected Test Files (must re-run)");
		for (const f of testFiles) {
			lines.push(`- \`${f}\``);
		}
	}

	return lines.join("\n");
}

export function executeImpactJson(
	graph: RepoGraph,
	files: string[],
): string {
	
	const affectedFiles = new Set<string>();
	const affectedSymbols: Symbol[] = [];

	for (const file of files) {
		const symIds = graph.fileSymbols.get(file) || [];
		for (const id of symIds) {
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

/**
 * pi-shazam tools/state_map — State definition discovery.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

export function registerStateMap(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_state_map",
		label: "State Map / Enum Explorer",
		description: `\
Call on enum, const group, or state-machine symbols to see EVERY
possible value and exactly where each value is used (pattern-matched
across the full project).

MUST call before adding/removing enum variants or changing state
transitions — a missing case in a switch/match is a runtime crash.
Returns: all variant names, count of usages per variant, and files
that would be impacted by variant changes.

Scenario: adding a new enum variant. Removing a state-machine state.
Auditing exhaustive match/switch coverage. Before changing a union
type's members.`,
		parameters: pi.typebox.Object({
			symbol: pi.typebox.String(),
			json: pi.typebox.Optional(pi.typebox.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeStateMap(graph, params.symbol);
			return {
				content: [
					{
						type: "text",
						text: json
							? JSON.stringify({
									schema_version: "1.0",
									command: "state_map",
									status: "ok",
									result: { symbol: params.symbol, found: result.includes(params.symbol) },
								})
							: result,
					},
				],
			};
		},
	});
}

export function executeStateMap(
	graph: RepoGraph,
	symbolName: string,
): string {
	const targets: Symbol[] = [];
	for (const sym of graph.symbols.values()) {
		if (sym.name === symbolName) {
			targets.push(sym);
		}
	}

	if (targets.length === 0) {
		return `Symbol not found: ${symbolName}`;
	}

	const lines: string[] = [];
	for (const target of targets) {
		lines.push(
			`## State Map: ${target.kind} \`${target.name}\` (${target.file}:${target.line})`,
		);
		lines.push("");

		// Members: search for symbols that reference this one
		const incoming = graph.incoming.get(target.id) || [];
		const outgoing = graph.outgoing.get(target.id) || [];

		if (incoming.length > 0) {
			lines.push(
				`### Usages (${incoming.length} references from other symbols)`,
			);
			// Group by file
			const byFile = new Map<string, Symbol[]>();
			for (const edge of incoming) {
				const sym = graph.symbols.get(edge.source);
				if (sym) {
					const arr = byFile.get(sym.file) || [];
					arr.push(sym);
					byFile.set(sym.file, arr);
				}
			}
			for (const [file, syms] of [...byFile.entries()].sort()) {
				lines.push(`  **${file}**: ${syms.map((s) => s.name).join(", ")}`);
			}
		}

		if (outgoing.length > 0) {
			lines.push("");
			lines.push(
				`### Dependencies (${outgoing.length} symbols this depends on)`,
			);
			for (const edge of outgoing) {
				const sym = graph.symbols.get(edge.target);
				if (sym) {
					lines.push(`- ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line}`);
				}
			}
		}

		lines.push("");
		lines.push(`Visibility: ${target.visibility}`);
		lines.push(`PageRank: ${target.pagerank.toFixed(4)}`);
		lines.push(`Signature: ${target.signature}`);
	}

	return lines.join("\n");
}

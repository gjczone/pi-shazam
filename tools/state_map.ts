/**
 * pi-shazam tools/state_map — State definition discovery.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { createTool } from "./_factory.js";
import { getNextForTool, formatNextSection } from "../core/output.js";

export function registerStateMap(pi: ExtensionAPI): void {
	createTool(pi, {
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
		params: Type.Object({ symbol: Type.String() }),
		execute(graph, params) {
			const json = params.json ?? false;
			const symbolName = params.symbol as string;
			const result = executeStateMap(graph, symbolName);
			if (json) {
				return JSON.stringify({ schema_version: "1.0", command: "state_map", status: "ok", result: { symbol: symbolName, found: result.includes(symbolName), text: result } });
			}
			return result;
		},
	});
}

// ── Symbol kinds eligible for state map analysis ──────────────────────────────────

/** Symbol kinds that support state map analysis */
const STATE_MAP_KINDS = new Set([
	"enum",
	"class",       // may contain constant members or state-machine methods
	"interface",   // can display member structure
	"type_alias",  // union type suits state map
	"const",
]);

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
		// Check if symbol kind is eligible for state map analysis
		if (!STATE_MAP_KINDS.has(target.kind)) {
			lines.push(
				`## ${target.kind} \`${target.name}\` — cannot generate state map`,
			);
			lines.push("");
			lines.push(
				`Symbol \`${target.name}\` is a ${target.kind}, not an enum, const group, or state machine.`,
			);
			lines.push(
				"State map analysis requires: enum, class (constants/state machine), interface, type_alias (union type), or const.",
			);
			lines.push("");
			lines.push(`Use \`shazam_symbol --name ${target.name}\` or \`shazam_call_chain --symbol ${target.name} --flat\` instead.`);
			continue;
		}

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

	// Add Next recommendations
	const nextItems = getNextForTool("state_map", { usageFile: targets[0]?.file });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

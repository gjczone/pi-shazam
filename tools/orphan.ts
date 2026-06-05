/**
 * pi-shazam tools/orphan — Dead code detection.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { isNonSourceFile } from "./hotspots.js";

export function registerOrphan(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_orphan",
		label: "Dead Code Detection",
		description: `\
Call to find dead code: symbols with zero incoming references across
the entire project. Confidence ≥ 70 means LIKELY safe to delete.
Confidence < 70 means check for dynamic references (string dispatch,
reflection, macros, event listeners, test-only usage).

MUST call shazam_refs on each candidate before actual deletion to
confirm zero references. A "dead" function that's called via
getattr/dlsym/Reflect is still live — orphan detection cannot see
dynamic dispatch.

Config and generated files (package-lock.json, package.json, etc.)
are excluded — only source code is analyzed.

Scenario: cleaning up unused code. Finding abandoned modules. Before a
major refactor to identify removable surface area. After removing a
feature to find orphaned helpers.`,
		parameters: Type.Object({
			file: Type.Optional(Type.String()),
			minConfidence: Type.Optional(Type.Number()),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");
			const result = executeOrphan(
				graph,
				params.file,
				params.minConfidence ?? 50,
			);
			return {
				content: [
					{
						type: "text",
						text: json
							? executeOrphanJson(graph, params.file, params.minConfidence ?? 50)
							: result,
					},
				],
			};
		},
	});
}

interface OrphanCandidate {
	symbol: Symbol;
	confidence: number;
	reason: string;
}

export function executeOrphan(
	graph: RepoGraph,
	file?: string,
	minConfidence: number = 50,
): string {
	const candidates = findOrphans(graph, file, minConfidence);

	if (candidates.length === 0) {
		return "No orphan symbols detected.";
	}

	const lines: string[] = [];
	lines.push(
		`## Orphan Symbols (${candidates.length} candidates, min confidence ${minConfidence}%)`,
	);
	lines.push("");
	lines.push(
		"Symbols with zero incoming references. Confidence ≥ 70 = likely safe to delete.",
	);
	lines.push("ALWAYS verify with shazam_refs before actual deletion.");
	lines.push("");
	lines.push("Config and generated files are excluded from analysis.");
	lines.push("");

	// Group by file
	const byFile = new Map<string, OrphanCandidate[]>();
	for (const c of candidates) {
		const arr = byFile.get(c.symbol.file) || [];
		arr.push(c);
		byFile.set(c.symbol.file, arr);
	}

	for (const [f, cands] of [...byFile.entries()].sort()) {
		lines.push(`### ${f}`);
		for (const c of cands) {
			lines.push(
				`- ${c.symbol.kind} \`${c.symbol.name}\` L${c.symbol.line} — confidence ${c.confidence}% (${c.reason})`,
			);
		}
		lines.push("");
	}

	return lines.join("\n").trim();
}

export function executeOrphanJson(
	graph: RepoGraph,
	file?: string,
	minConfidence: number = 50,
): string {
	const candidates = findOrphans(graph, file, minConfidence);
	return JSON.stringify({
		schema_version: "1.0",
		command: "orphan",
		status: "ok",
		result: {
			count: candidates.length,
			candidates: candidates.map((c) => ({
				id: c.symbol.id,
				name: c.symbol.name,
				kind: c.symbol.kind,
				file: c.symbol.file,
				line: c.symbol.line,
				confidence: c.confidence,
				reason: c.reason,
			})),
		},
	});
}

function findOrphans(
	graph: RepoGraph,
	file?: string,
	minConfidence: number = 50,
): OrphanCandidate[] {
	const candidates: OrphanCandidate[] = [];

	for (const sym of graph.symbols.values()) {
		if (file && sym.file !== file) continue;

		// 排除配置文件中的符号 —— 它们不是代码孤岛
		if (isNonSourceFile(sym.file)) continue;

		const incoming = graph.incoming.get(sym.id);
		const outgoing = graph.outgoing.get(sym.id);
		const incCount = incoming ? incoming.length : 0;

		if (incCount > 0) continue; // Has references, not orphan

		// Determine confidence based on visibility and outgoing edges
		let confidence = 0;
		let reason = "";

		if (sym.visibility === "private") {
			confidence = 90;
			reason = "private symbol with no incoming references";
		} else if (sym.name.startsWith("_")) {
			confidence = 85;
			reason = "underscore-prefixed with no incoming references";
		} else if (!outgoing || outgoing.length === 0) {
			confidence = 70;
			reason = "no incoming or outgoing references; possibly dead";
		} else {
			confidence = 50;
			reason = "has outgoing refs but no incoming; may be test-only or entry point";
		}

		if (confidence >= minConfidence) {
			candidates.push({ symbol: sym, confidence, reason });
		}
	}

	return candidates.sort((a, b) => b.confidence - a.confidence);
}

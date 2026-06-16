/**
 * pi-shazam tools/impact — Change blast radius analysis.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool } from "./_factory.js";
import { buildEnvelope } from "./_factory.js";
import { executeFindTests } from "./find_tests.js";
import { isNonSourceFile } from "../core/filter.js";

export function registerImpact(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_impact",
		label: "Change Impact Analysis",
		description: `\
		Required before editing 2+ files or any shared/exported module.
		Returns every file, symbol, and test affected by your planned changes.
		Without this, you are guessing which tests to run and which callers to
		update. Pass --with-symbols for per-symbol risk breakdown. Pass
		--compact for concise output (file names only). Pass --depth to
		control BFS traversal depth (default 3). Supports multiple --files.`,
		params: Type.Object({
			files: Type.Array(Type.String()),
			withSymbols: Type.Optional(Type.Boolean()),
			compact: Type.Optional(Type.Boolean()),
			depth: Type.Optional(Type.Number()),
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			if (!params.files || !Array.isArray(params.files)) {
				return "Error: --files is required (must be an array of file paths)";
			}
			const files = params.files as string[];
			const depth = Math.min(Math.max((params.depth as number) ?? 3, 1), 10);
			return json
				? executeImpactJson(graph, files, depth)
				: executeImpact(graph, files, {
						withSymbols: (params.withSymbols as boolean) ?? false,
						compact: (params.compact as boolean) ?? false,
						depth,
					});
		},
	});
}

interface ImpactOptions {
	withSymbols: boolean;
	compact: boolean;
	depth: number;
}

interface AffectedSymbol {
	symbol: Symbol;
	direction: "upstream" | "downstream";
}

export function executeImpact(
	graph: RepoGraph,
	files: string[],
	opts: ImpactOptions = { withSymbols: false, compact: false, depth: 3 },
): string {
	const affectedFiles = new Set<string>();
	const affectedSymbols: AffectedSymbol[] = [];
	const depth = opts.depth ?? 3;

	// Collect initial symbol IDs from target files
	const initialSymIds: string[] = [];
	for (const file of files) {
		affectedFiles.add(file);
		const symIds = graph.fileSymbols.get(file) || [];
		initialSymIds.push(...symIds);
	}

	// BFS upstream: what calls/imports symbols from this file (and transitively)?
	const visitedUp = new Set<string>();
	const queueUp: { id: string; level: number }[] = initialSymIds.map((id) => ({ id, level: 0 }));
	for (const id of initialSymIds) visitedUp.add(id);

	while (queueUp.length > 0) {
		const { id, level } = queueUp.shift()!;
		if (level >= depth) continue;

		const incoming = graph.incoming.get(id);
		if (incoming) {
			for (const edge of incoming) {
				if (visitedUp.has(edge.source)) continue;
				visitedUp.add(edge.source);
				const callerSym = graph.symbols.get(edge.source);
				if (callerSym && !files.includes(callerSym.file) && !isNonSourceFile(callerSym.file)) {
					affectedFiles.add(callerSym.file);
					if (opts.withSymbols) {
						affectedSymbols.push({ symbol: callerSym, direction: "upstream" });
					}
					queueUp.push({ id: edge.source, level: level + 1 });
				}
			}
		}
	}

	// BFS downstream: what does this file's symbols depend on (and transitively)?
	const visitedDown = new Set<string>();
	const queueDown: { id: string; level: number }[] = initialSymIds.map((id) => ({ id, level: 0 }));
	for (const id of initialSymIds) visitedDown.add(id);

	while (queueDown.length > 0) {
		const { id, level } = queueDown.shift()!;
		if (level >= depth) continue;

		const outgoing = graph.outgoing.get(id);
		if (outgoing) {
			for (const edge of outgoing) {
				if (visitedDown.has(edge.target)) continue;
				visitedDown.add(edge.target);
				const calleeSym = graph.symbols.get(edge.target);
				if (calleeSym && !files.includes(calleeSym.file) && !isNonSourceFile(calleeSym.file)) {
					affectedFiles.add(calleeSym.file);
					if (opts.withSymbols) {
						affectedSymbols.push({ symbol: calleeSym, direction: "downstream" });
					}
					queueDown.push({ id: edge.target, level: level + 1 });
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
	lines.push(`Traversal depth: ${depth}`);
	if (opts.withSymbols) {
		lines.push(`Affected symbols: ${affectedSymbols.length}`);
	}
	lines.push("");

	// Risk assessment
	const risk = assessImpactRisk(affectedFiles.size - files.length, affectedSymbols.length);
	lines.push(`### Risk Assessment`);
	lines.push(`**${risk.level}** — ${risk.reason}`);
	lines.push("");

	if (affectedFiles.size > files.length) {
		lines.push("### Affected Files & Symbols");
		lines.push("");

		// Group by file and show symbols
		const fileSymbols = new Map<string, AffectedSymbol[]>();
		for (const affected of affectedSymbols) {
			const fileSyms = fileSymbols.get(affected.symbol.file) || [];
			fileSyms.push(affected);
			fileSymbols.set(affected.symbol.file, fileSyms);
		}

		for (const f of [...affectedFiles].sort()) {
			if (files.includes(f)) continue;
			const syms = fileSymbols.get(f) || [];
			if (syms.length > 0) {
				// Determine direction (use majority)
				const upstreamCount = syms.filter((s) => s.direction === "upstream").length;
				const downstreamCount = syms.filter((s) => s.direction === "downstream").length;
				const direction = upstreamCount > downstreamCount ? "upstream caller" : "downstream callee";
				lines.push(`#### \`${f}\` (${direction})`);
				for (const affected of syms.slice(0, 5)) {
					lines.push(`- ${affected.symbol.kind} \`${affected.symbol.name}\` — line ${affected.symbol.line}`);
				}
				if (syms.length > 5) {
					lines.push(`  ... and ${syms.length - 5} more`);
				}
			} else {
				lines.push(`- \`${f}\``);
			}
		}
	}

	// Identify test files in affected set
	const testFiles = [...affectedFiles].filter(
		(f) => f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__") || f.startsWith("tests/"),
	);
	if (testFiles.length > 0) {
		lines.push("");
		lines.push("### Affected Tests (must re-run)");
		for (const f of testFiles) {
			lines.push(`- \`${f}\``);
		}
	}

	// Discover tests for target files
	const discoveredTests: string[] = [];
	for (const file of files) {
		const testResult = executeFindTests(graph, ".", { sourceFile: file });
		for (const match of testResult.matches) {
			if (!discoveredTests.includes(match.testFile)) {
				discoveredTests.push(match.testFile);
			}
		}
	}
	if (discoveredTests.length > 0) {
		lines.push("");
		lines.push("### Discovered Tests for Target Files");
		for (const f of discoveredTests) {
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

function assessImpactRisk(affectedFileCount: number, affectedSymbolCount: number): { level: string; reason: string } {
	if (affectedFileCount === 0 && affectedSymbolCount === 0) {
		return { level: "low", reason: "No external impact detected." };
	}
	if (affectedFileCount > 10 || affectedSymbolCount > 30) {
		return {
			level: "high",
			reason: `${affectedFileCount} files, ${affectedSymbolCount} symbols affected — extensive blast radius.`,
		};
	}
	if (affectedFileCount > 3 || affectedSymbolCount > 10) {
		return {
			level: "medium",
			reason: `${affectedFileCount} files, ${affectedSymbolCount} symbols affected — moderate blast radius.`,
		};
	}
	return {
		level: "low",
		reason: `${affectedFileCount} files, ${affectedSymbolCount} symbols affected — contained blast radius.`,
	};
}

export function executeImpactJson(graph: RepoGraph, files: string[], depth: number = 3): string {
	const affectedFiles = new Set<string>();
	const affectedSymbols: AffectedSymbol[] = [];

	// Collect initial symbol IDs from target files
	const initialSymIds: string[] = [];
	for (const file of files) {
		const symIds = graph.fileSymbols.get(file) || [];
		initialSymIds.push(...symIds);
	}

	// BFS upstream
	const visitedUp = new Set<string>();
	const queueUp: { id: string; level: number }[] = initialSymIds.map((id) => ({ id, level: 0 }));
	for (const id of initialSymIds) visitedUp.add(id);

	while (queueUp.length > 0) {
		const { id, level } = queueUp.shift()!;
		if (level >= depth) continue;
		const incoming = graph.incoming.get(id);
		if (incoming) {
			for (const edge of incoming) {
				if (visitedUp.has(edge.source)) continue;
				visitedUp.add(edge.source);
				const callerSym = graph.symbols.get(edge.source);
				if (callerSym && !files.includes(callerSym.file) && !isNonSourceFile(callerSym.file)) {
					affectedFiles.add(callerSym.file);
					affectedSymbols.push({ symbol: callerSym, direction: "upstream" });
					queueUp.push({ id: edge.source, level: level + 1 });
				}
			}
		}
	}

	// BFS downstream
	const visitedDown = new Set<string>();
	const queueDown: { id: string; level: number }[] = initialSymIds.map((id) => ({ id, level: 0 }));
	for (const id of initialSymIds) visitedDown.add(id);

	while (queueDown.length > 0) {
		const { id, level } = queueDown.shift()!;
		if (level >= depth) continue;
		const outgoing = graph.outgoing.get(id);
		if (outgoing) {
			for (const edge of outgoing) {
				if (visitedDown.has(edge.target)) continue;
				visitedDown.add(edge.target);
				const calleeSym = graph.symbols.get(edge.target);
				if (calleeSym && !files.includes(calleeSym.file) && !isNonSourceFile(calleeSym.file)) {
					affectedFiles.add(calleeSym.file);
					affectedSymbols.push({ symbol: calleeSym, direction: "downstream" });
					queueDown.push({ id: edge.target, level: level + 1 });
				}
			}
		}
	}

	// Discover tests for target files
	const discoveredTests: string[] = [];
	for (const file of files) {
		const testResult = executeFindTests(graph, ".", { sourceFile: file });
		for (const match of testResult.matches) {
			if (!discoveredTests.includes(match.testFile)) {
				discoveredTests.push(match.testFile);
			}
		}
	}

	const risk = assessImpactRisk(affectedFiles.size - files.length, affectedSymbols.length);

	return buildEnvelope("shazam_impact", process.cwd(), "ok", {
		targetFiles: files,
		affectedFileCount: affectedFiles.size - files.length,
		affectedFiles: [...affectedFiles].filter((f) => !files.includes(f)).sort(),
		affectedSymbols: affectedSymbols.slice(0, 50).map((a) => ({
			id: a.symbol.id,
			name: a.symbol.name,
			kind: a.symbol.kind,
			file: a.symbol.file,
			line: a.symbol.line,
			direction: a.direction,
		})),
		risk: risk,
		discoveredTests: discoveredTests,
	});
}

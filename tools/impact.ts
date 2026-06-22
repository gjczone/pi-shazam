/**
 * pi-shazam tools/impact — Change blast radius analysis + call chain.
 *
 * Merged with call_chain (issue #362): now supports --symbol for per-symbol
 * caller/callee tracing in addition to file-level impact analysis.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool } from "./_factory.js";
import { buildEnvelope } from "./_factory.js";
import { executeFindTests } from "./find_tests.js";
import { isNonSourceFile } from "../core/filter.js";
import { recordCallChain } from "../hooks/rename-state.js";

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
		control BFS traversal depth (default 3). Supports multiple --files.
		Pass --symbol for per-symbol caller/callee tracing (replaces
		shazam_call_chain). Pass --flat for a flat list of references.
		Pass --direction to filter by incoming/outgoing/both.`,
		params: Type.Object({
			files: Type.Optional(Type.Array(Type.String())),
			symbol: Type.Optional(Type.String()),
			withSymbols: Type.Optional(Type.Boolean()),
			compact: Type.Optional(Type.Boolean()),
			depth: Type.Optional(Type.Number()),
			flat: Type.Optional(Type.Boolean()),
			direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")])),
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			const depth = Math.min(Math.max((params.depth as number) ?? 3, 1), 10);
			const symbolName = params.symbol as string | undefined;

			// Symbol mode: call chain analysis (replaces shazam_call_chain)
			if (symbolName) {
				recordCallChain(symbolName);
				const flat = (params.flat as boolean) ?? false;
				const direction = (params.direction as "incoming" | "outgoing" | "both") ?? "both";
				if (flat) {
					const refs = _getFlatReferences(graph, symbolName, direction);
					return json ? JSON.stringify(refs, null, 2) : _formatFlatReferences(refs, symbolName);
				}
				return json
					? _executeCallChainJson(graph, symbolName, depth, direction)
					: _executeCallChain(graph, symbolName, depth, direction);
			}

			// File mode: impact analysis
			if (!params.files || !Array.isArray(params.files)) {
				return "Error: either --files (array of file paths) or --symbol (symbol name) is required";
			}
			const files = params.files as string[];
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

/**
 * Result of the shared BFS traversal used by both text and JSON impact formatters.
 * affectedFiles contains only external (non-target, non-generated) files reachable
 * via upstream or downstream edges within the given depth limit.
 */
interface ImpactBfsResult {
	affectedFiles: Set<string>;
	affectedSymbols: AffectedSymbol[];
}

/**
 * Perform upstream + downstream BFS traversal from the symbols in the target files.
 * Single source of truth for impact blast-radius computation (issue #325).
 *
 * - Upstream: follows incoming edges (callers/importers of target symbols).
 * - Downstream: follows outgoing edges (callees/dependencies of target symbols).
 * - Skips non-source files (generated, config) and the target files themselves.
 */
function computeImpactBfs(graph: RepoGraph, files: string[], depth: number): ImpactBfsResult {
	const affectedFiles = new Set<string>();
	const affectedSymbols: AffectedSymbol[] = [];

	// Collect initial symbol IDs from target files
	const initialSymIds: string[] = [];
	for (const file of files) {
		const symIds = graph.fileSymbols.get(file) || [];
		initialSymIds.push(...symIds);
	}

	// BFS upstream: what calls/imports symbols from these files (and transitively)?
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

	// BFS downstream: what do these files' symbols depend on (and transitively)?
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

	return { affectedFiles, affectedSymbols };
}

export function executeImpact(
	graph: RepoGraph,
	files: string[],
	opts: ImpactOptions = { withSymbols: false, compact: false, depth: 3 },
): string {
	const depth = opts.depth ?? 3;
	const bfs = computeImpactBfs(graph, files, depth);
	const affectedSymbols = opts.withSymbols ? bfs.affectedSymbols : [];

	if (opts.compact) {
		return [...bfs.affectedFiles].sort().join("\n");
	}

	const lines: string[] = [];
	lines.push("## Impact Analysis");
	lines.push("");
	lines.push(`Target files: ${files.join(", ")}`);
	lines.push(`Affected files: ${bfs.affectedFiles.size}`);
	lines.push(`Traversal depth: ${depth}`);
	if (opts.withSymbols) {
		lines.push(`Affected symbols: ${affectedSymbols.length}`);
	}
	lines.push("");

	// Risk assessment
	const risk = assessImpactRisk(bfs.affectedFiles.size, affectedSymbols.length);
	lines.push(`### Risk Assessment`);
	lines.push(`**${risk.level}** — ${risk.reason}`);
	lines.push("");

	if (bfs.affectedFiles.size > 0) {
		lines.push("### Affected Files & Symbols");
		lines.push("");

		// Group by file and show symbols
		const fileSymbols = new Map<string, AffectedSymbol[]>();
		for (const affected of affectedSymbols) {
			const fileSyms = fileSymbols.get(affected.symbol.file) || [];
			fileSyms.push(affected);
			fileSymbols.set(affected.symbol.file, fileSyms);
		}

		for (const f of [...bfs.affectedFiles].sort()) {
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

	// Identify test files in affected set (include target files for test detection)
	const testFiles = [...bfs.affectedFiles, ...files].filter(
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
	const bfs = computeImpactBfs(graph, files, depth);

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

	const risk = assessImpactRisk(bfs.affectedFiles.size, bfs.affectedSymbols.length);

	return buildEnvelope("shazam_impact", process.cwd(), "ok", {
		targetFiles: files,
		affectedFileCount: bfs.affectedFiles.size,
		affectedFiles: [...bfs.affectedFiles].sort(),
		affectedSymbols: bfs.affectedSymbols.slice(0, 50).map((a) => ({
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

// ── Call chain (absorbed from tools/call_chain.ts) ──────────────────────

const MAX_DISPLAY_REFS = 50;

function _executeCallChain(
	graph: RepoGraph,
	symbolName: string,
	depth: number = 2,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	const targets = graph.nameIndex.get(symbolName) ?? [];
	if (targets.length === 0) return `Symbol not found: ${symbolName}`;

	const lines: string[] = [];
	for (const target of targets) {
		lines.push(`## Call Chain for ${target.kind} \`${target.name}\` (${target.file}:${target.line})`);
		lines.push("");

		if (direction !== "outgoing") {
			const chain = _traceIncoming(graph, target.id, depth);
			if (chain.length > 0) {
				const shown = chain.slice(0, MAX_DISPLAY_REFS);
				lines.push(`### Incoming Calls (${chain.length} callers in ${depth} levels)`);
				for (const [level, sym, edge] of shown) {
					const indent = "  ".repeat(level);
					lines.push(`${indent}L${level}: ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (${edge.kind})`);
				}
				if (chain.length > MAX_DISPLAY_REFS) lines.push(`  ... and ${chain.length - MAX_DISPLAY_REFS} more`);
			}
		}

		if (direction !== "incoming") {
			const chain = _traceOutgoing(graph, target.id, depth);
			if (chain.length > 0) {
				const shown = chain.slice(0, MAX_DISPLAY_REFS);
				lines.push("");
				lines.push(`### Outgoing Calls (${chain.length} callees in ${depth} levels)`);
				for (const [level, sym, edge] of shown) {
					const indent = "  ".repeat(level);
					lines.push(`${indent}L${level}: ${sym.kind} \`${sym.name}\` — ${sym.file}:${sym.line} (${edge.kind})`);
				}
				if (chain.length > MAX_DISPLAY_REFS) lines.push(`  ... and ${chain.length - MAX_DISPLAY_REFS} more`);
			}
		}

		lines.push("");
	}

	const nextItems = getNextForTool("impact", { topSymbol: targets[0]?.name });
	if (nextItems.length > 0) {
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n").trim();
}

function _executeCallChainJson(
	graph: RepoGraph,
	symbolName: string,
	depth: number,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	const targets = graph.nameIndex.get(symbolName) ?? [];
	const result = targets.map((target) => ({
		symbol: { id: target.id, name: target.name, kind: target.kind, file: target.file, line: target.line },
		incoming:
			direction !== "outgoing"
				? _traceIncoming(graph, target.id, depth).map(([level, sym, edge]) => ({
						level,
						symbol: sym.name,
						file: sym.file,
						kind: edge.kind,
					}))
				: [],
		outgoing:
			direction !== "incoming"
				? _traceOutgoing(graph, target.id, depth).map(([level, sym, edge]) => ({
						level,
						symbol: sym.name,
						file: sym.file,
						kind: edge.kind,
					}))
				: [],
	}));

	return buildEnvelope("shazam_impact", process.cwd(), "ok", result);
}

function _traceIncoming(graph: RepoGraph, startId: string, maxDepth: number): [number, Symbol, { kind: string }][] {
	const visited = new Set<string>();
	const result: [number, Symbol, { kind: string }][] = [];
	const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
	visited.add(startId);

	while (queue.length > 0) {
		const { id, depth } = queue.shift()!;
		if (depth >= maxDepth) continue;
		const incoming = graph.incoming.get(id);
		if (!incoming) continue;
		for (const edge of incoming) {
			const srcSym = graph.symbols.get(edge.source);
			if (!srcSym || visited.has(edge.source)) continue;
			visited.add(edge.source);
			result.push([depth + 1, srcSym, edge]);
			queue.push({ id: edge.source, depth: depth + 1 });
		}
	}

	return result;
}

function _traceOutgoing(graph: RepoGraph, startId: string, maxDepth: number): [number, Symbol, { kind: string }][] {
	const visited = new Set<string>();
	const result: [number, Symbol, { kind: string }][] = [];
	const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
	visited.add(startId);

	while (queue.length > 0) {
		const { id, depth } = queue.shift()!;
		if (depth >= maxDepth) continue;
		const outgoing = graph.outgoing.get(id);
		if (!outgoing) continue;
		for (const edge of outgoing) {
			const tgtSym = graph.symbols.get(edge.target);
			if (!tgtSym || visited.has(edge.target)) continue;
			visited.add(edge.target);
			result.push([depth + 1, tgtSym, edge]);
			queue.push({ id: edge.target, depth: depth + 1 });
		}
	}

	return result;
}

interface FlatReference {
	symbol: string;
	file: string;
	line: number;
	kind: string;
	direction: string;
}

function _getFlatReferences(
	graph: RepoGraph,
	symbolName: string,
	direction: "incoming" | "outgoing" | "both" = "both",
): FlatReference[] {
	const targets = graph.nameIndex.get(symbolName) ?? [];
	if (targets.length === 0) return [];

	const refs: FlatReference[] = [];
	const seen = new Set<string>();

	for (const target of targets) {
		if (direction !== "outgoing") {
			const incoming = graph.incoming.get(target.id);
			if (incoming) {
				for (const edge of incoming) {
					const src = graph.symbols.get(edge.source);
					if (!src) continue;
					const key = `${src.name}:${src.file}:${src.line}`;
					if (seen.has(key)) continue;
					seen.add(key);
					refs.push({ symbol: src.name, file: src.file, line: src.line, kind: src.kind, direction: "incoming" });
				}
			}
		}
		if (direction !== "incoming") {
			const outgoing = graph.outgoing.get(target.id);
			if (outgoing) {
				for (const edge of outgoing) {
					const tgt = graph.symbols.get(edge.target);
					if (!tgt) continue;
					const key = `${tgt.name}:${tgt.file}:${tgt.line}`;
					if (seen.has(key)) continue;
					seen.add(key);
					refs.push({ symbol: tgt.name, file: tgt.file, line: tgt.line, kind: tgt.kind, direction: "outgoing" });
				}
			}
		}
	}

	return refs;
}

function _formatFlatReferences(refs: FlatReference[], symbolName: string): string {
	if (refs.length === 0) return `No references found for "${symbolName}".`;

	const lines: string[] = [`## Flat References for \`${symbolName}\` (${refs.length} total)`, ""];
	const incoming = refs.filter((r) => r.direction === "incoming");
	const outgoing = refs.filter((r) => r.direction === "outgoing");

	if (incoming.length > 0) {
		lines.push(`### Incoming (${incoming.length})`);
		for (const r of incoming.slice(0, MAX_DISPLAY_REFS))
			lines.push(`- ${r.kind} \`${r.symbol}\` — ${r.file}:${r.line}`);
		if (incoming.length > MAX_DISPLAY_REFS) lines.push(`  ... and ${incoming.length - MAX_DISPLAY_REFS} more`);
		lines.push("");
	}

	if (outgoing.length > 0) {
		lines.push(`### Outgoing (${outgoing.length})`);
		for (const r of outgoing.slice(0, MAX_DISPLAY_REFS))
			lines.push(`- ${r.kind} \`${r.symbol}\` — ${r.file}:${r.line}`);
		if (outgoing.length > MAX_DISPLAY_REFS) lines.push(`  ... and ${outgoing.length - MAX_DISPLAY_REFS} more`);
		lines.push("");
	}

	return lines.join("\n");
}

// ── Backward-compatible exports (for call_chain tests) ─────────────────

export function executeCallChain(
	graph: RepoGraph,
	symbolName: string,
	depth: number = 2,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	recordCallChain(symbolName);
	return _executeCallChain(graph, symbolName, depth, direction);
}

export function executeCallChainJson(
	graph: RepoGraph,
	symbolName: string,
	depth: number,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	return _executeCallChainJson(graph, symbolName, depth, direction);
}

export function getFlatReferences(
	graph: RepoGraph,
	symbolName: string,
	direction: "incoming" | "outgoing" | "both" = "both",
): FlatReference[] {
	return _getFlatReferences(graph, symbolName, direction);
}

export function formatFlatReferences(refs: FlatReference[], symbolName: string): string {
	return _formatFlatReferences(refs, symbolName);
}

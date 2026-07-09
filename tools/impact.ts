/**
 * pi-shazam tools/impact -- Change blast radius analysis + call chain.
 *
 * Merged with call_chain (issue #362): now supports --symbol for per-symbol
 * caller/callee tracing in addition to file-level impact analysis.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { Edge, Provenance, RepoGraph, Symbol } from "../core/graph.js";
import { getNextForTool, formatNextSection } from "../core/output.js";
import { createTool, buildEnvelope } from "./_factory.js";
import { dispatchImpact } from "./_dispatchers.js";
import { isNonSourceFile } from "../core/filter.js";
import { assessRisk } from "../core/risk.js";
import { recordCallChain } from "./rename-state.js";
import { getEffectiveRoot } from "../core/scanner.js";
import { isTestFile, filterTestFiles } from "../core/test-patterns.js";
import type { SymbolLookupProvenanceCounts } from "./lookup.js";

/**
 * Default zeroed provenance counts, used as the initial accumulator
 * when summarizing edge provenance for an affected symbol.
 */
const ZERO_PROVENANCE_COUNTS: SymbolLookupProvenanceCounts = {
	resolved: 0,
	name_match: 0,
	heuristic: 0,
	unresolved: 0,
};

/**
 * Count edges by provenance for a single symbol. Iterates both the
 * incoming and outgoing edge lists of the symbol and tallies each
 * `Edge.provenance` value. Edges without a provenance field default
 * to "heuristic" to match `DEFAULT_PROVENANCE` in core/graph.ts.
 */
function _countProvenance(graph: RepoGraph, symbolId: string): SymbolLookupProvenanceCounts {
	const counts: SymbolLookupProvenanceCounts = { ...ZERO_PROVENANCE_COUNTS };
	for (const list of [graph.incoming.get(symbolId), graph.outgoing.get(symbolId)]) {
		if (!list) continue;
		for (const edge of list) {
			const p: Provenance = (edge.provenance ?? "heuristic") as Provenance;
			counts[p]++;
		}
	}
	return counts;
}

/**
 * Render a compact provenance summary for markdown output, e.g.
 * "R:1 H:1 N:1" for one edge in each category. Categories with
 * zero count are omitted so the output stays tight.
 */
function _renderProvenanceBadge(counts: SymbolLookupProvenanceCounts): string {
	const parts: string[] = [];
	if (counts.resolved > 0) parts.push(`R:${counts.resolved}`);
	if (counts.name_match > 0) parts.push(`N:${counts.name_match}`);
	if (counts.heuristic > 0) parts.push(`H:${counts.heuristic}`);
	if (counts.unresolved > 0) parts.push(`U:${counts.unresolved}`);
	return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

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
			const projectRoot = (params.project as string) || ".";
			return dispatchImpact(graph, params, projectRoot).text;
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

	// Convert target files to Set for O(1) lookup on BFS hot path
	const targetFileSet = new Set<string>(files);

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

	let headUp = 0;
	while (headUp < queueUp.length) {
		const { id, level } = queueUp[headUp++];
		if (level >= depth) continue;

		const incoming = graph.incoming.get(id);
		if (incoming) {
			for (const edge of incoming) {
				if (visitedUp.has(edge.source)) continue;
				visitedUp.add(edge.source);
				const callerSym = graph.symbols.get(edge.source);
				if (callerSym && !targetFileSet.has(callerSym.file) && !isNonSourceFile(callerSym.file)) {
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

	let headDown = 0;
	while (headDown < queueDown.length) {
		const { id, level } = queueDown[headDown++];
		if (level >= depth) continue;

		const outgoing = graph.outgoing.get(id);
		if (outgoing) {
			for (const edge of outgoing) {
				if (visitedDown.has(edge.target)) continue;
				visitedDown.add(edge.target);
				const calleeSym = graph.symbols.get(edge.target);
				if (calleeSym && !targetFileSet.has(calleeSym.file) && !isNonSourceFile(calleeSym.file)) {
					affectedFiles.add(calleeSym.file);
					affectedSymbols.push({ symbol: calleeSym, direction: "downstream" });
					queueDown.push({ id: edge.target, level: level + 1 });
				}
			}
		}
	}

	return { affectedFiles, affectedSymbols };
}

/**
 * Compute the per-file blast-radius direction label from the counts of
 * affected upstream (caller) and downstream (callee) symbols.
 *
 * A strict `>` previously labeled every tie or zero/zero case as
 * "downstream callee", which is misleading (issue #656). Ties are now
 * labeled "both" so the direction is accurate or omitted.
 */
export function computeFileDirection(upstreamCount: number, downstreamCount: number): string {
	if (upstreamCount > downstreamCount) return "upstream caller";
	if (upstreamCount < downstreamCount) return "downstream callee";
	return "both";
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
		const affected = [...bfs.affectedFiles].sort();
		const affectedTests = [...bfs.affectedFiles, ...files].filter((f) => isTestFile(f));
		const lines = [`## Impact (Compact)`, ``, `${affected.length} affected file(s):`, ``, affected.join("\n")];
		if (affectedTests.length > 0) {
			lines.push(``, `Affected Tests (must re-run): ${affectedTests.length}`);
		}
		return lines.join("\n");
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
	lines.push(`**${risk.level}** - ${risk.reason}`);
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
				const direction = computeFileDirection(upstreamCount, downstreamCount);
				// #631 B: aggregate provenance counts across all affected
				// symbols in this file so the markdown line shows a single
				// compact summary of how much of the blast radius is
				// LSP-resolved vs tree-sitter-heuristic.
				const fileCounts: SymbolLookupProvenanceCounts = { ...ZERO_PROVENANCE_COUNTS };
				for (const s of syms) {
					const c = _countProvenance(graph, s.symbol.id);
					fileCounts.resolved += c.resolved;
					fileCounts.name_match += c.name_match;
					fileCounts.heuristic += c.heuristic;
					fileCounts.unresolved += c.unresolved;
				}
				lines.push(`#### \`${f}\` (${direction})${_renderProvenanceBadge(fileCounts)}`);
				for (const affected of syms.slice(0, 5)) {
					lines.push(`- ${affected.symbol.kind} \`${affected.symbol.name}\` - line ${affected.symbol.line}`);
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
	appendAffectedTests(lines, [...bfs.affectedFiles, ...files]);

	// Add Next recommendations
	const nextItems = getNextForTool("impact", { topSymbol: files[0] });
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

function assessImpactRisk(affectedFileCount: number, affectedSymbolCount: number): { level: string; reason: string } {
	return assessRisk({
		mode: "impact",
		gitFileCount: affectedFileCount,
		newOrphanCount: affectedSymbolCount,
		orphanDelta: 0,
	});
}

/**
 * #631 A: typed return value of shazam_impact (files mode). The
 * dispatcher wraps this in buildEnvelope for JSON mode; the
 * existing executeImpact text path is unchanged for backward
 * compat with the test suite.
 */
export interface ImpactAffectedSymbol {
	id: string;
	name: string;
	kind: string;
	file: string;
	line: number;
	direction: "upstream" | "downstream";
	/**
	 * Edge provenance breakdown (issue #631 B). Counts how many of the
	 * symbol's incoming + outgoing edges fall into each provenance
	 * category ("resolved", "name_match", "heuristic", "unresolved").
	 * Lets JSON consumers tell at a glance which call sites are
	 * LSP-resolved vs tree-sitter-heuristic.
	 */
	provenanceCounts: SymbolLookupProvenanceCounts;
}

export interface ImpactResult {
	kind: "impact";
	targetFiles: string[];
	depth: number;
	affectedFileCount: number;
	affectedFiles: string[];
	affectedSymbols: ImpactAffectedSymbol[];
	affectedTests: string[];
	risk: { level: string; reason: string };
}

/**
 * #631 A: build the typed ImpactResult. Single source of truth for
 * the JSON envelope; previously the shape was inlined inside
 * executeImpactJson.
 */
export function buildImpactResult(graph: RepoGraph, files: string[], depth: number = 3): ImpactResult {
	const bfs = computeImpactBfs(graph, files, depth);
	const risk = assessImpactRisk(bfs.affectedFiles.size, bfs.affectedSymbols.length);
	// #635: collect test paths from the affected file set (unified with
	// call-chain). The text-mode executeImpact uses appendAffectedTests;
	// the JSON envelope mirrors that.
	const allFiles = [...bfs.affectedFiles, ...files];
	const affectedTests = allFiles.filter((f) => isTestFile(f));
	return {
		kind: "impact",
		targetFiles: files,
		depth,
		affectedFileCount: bfs.affectedFiles.size,
		affectedFiles: [...bfs.affectedFiles].sort(),
		affectedSymbols: bfs.affectedSymbols.slice(0, 50).map((a) => ({
			id: a.symbol.id,
			name: a.symbol.name,
			kind: a.symbol.kind,
			file: a.symbol.file,
			line: a.symbol.line,
			direction: a.direction,
			// #631 B: per-affected-symbol edge provenance summary
			provenanceCounts: _countProvenance(graph, a.symbol.id),
		})),
		affectedTests,
		risk,
	};
}

export function executeImpactJson(graph: RepoGraph, files: string[], depth: number = 3): string {
	return buildEnvelope("shazam_impact", getEffectiveRoot(), "ok", buildImpactResult(graph, files, depth));
}

// -- Call chain (absorbed from tools/call_chain.ts) ----------------------

/**
 * Append the "### Affected Tests (must re-run)" section to a markdown
 * output buffer if any of the given paths look like test files.
 *
 * Shared between the file-mode path (`executeImpact`) and the symbol-mode
 * call-chain path (`_executeCallChain`) so both modes surface the same
 * "what tests to re-run" hint. See issue #635.
 *
 * Pure formatting helper: no side effects beyond mutating the caller's
 * `lines` array (an empty leading line is appended before the section).
 */
export function appendAffectedTests(lines: string[], paths: string[]): void {
	const tests = paths.filter(isTestFile);
	if (tests.length === 0) return;
	lines.push("");
	lines.push("### Affected Tests (must re-run)");
	for (const f of tests) {
		lines.push(`- \`${f}\``);
	}
}

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
	// Collect every file touched by the call chain so we can surface tests.
	// Includes the target's own file plus every symbol seen during traversal.
	const referencedFiles = new Set<string>();
	for (const target of targets) {
		referencedFiles.add(target.file);
		lines.push(`## Call Chain for ${target.kind} \`${target.name}\` (${target.file}:${target.line})`);
		lines.push("");

		if (direction !== "outgoing") {
			const chain = _traceIncoming(graph, target.id, depth);
			if (chain.length > 0) {
				const shown = chain.slice(0, MAX_DISPLAY_REFS);
				lines.push(`### Incoming Calls (${chain.length} callers in ${depth} levels)`);
				for (const [level, sym, edge] of shown) {
					const indent = "  ".repeat(level);
					lines.push(`${indent}L${level}: ${sym.kind} \`${sym.name}\` - ${sym.file}:${sym.line} (${edge.kind})`);
					referencedFiles.add(sym.file);
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
					lines.push(`${indent}L${level}: ${sym.kind} \`${sym.name}\` - ${sym.file}:${sym.line} (${edge.kind})`);
					referencedFiles.add(sym.file);
				}
				if (chain.length > MAX_DISPLAY_REFS) lines.push(`  ... and ${chain.length - MAX_DISPLAY_REFS} more`);
			}
		}

		lines.push("");
	}

	// Surface test files touched by the call chain so the agent knows what
	// to re-run. Unified with the file-mode output via `appendAffectedTests`
	// (issue #635).
	appendAffectedTests(lines, [...referencedFiles]);

	const nextItems = getNextForTool("impact", { topSymbol: targets[0]?.name });
	if (nextItems.length > 0) {
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n").trim();
}

/**
 * #631 A: typed return value of shazam_impact (symbol/call-chain mode).
 * One CallChainEntry per matching symbol name; the dispatcher
 * (tools/_dispatchers.ts) wraps the whole array in buildEnvelope.
 */
export interface CallChainEdge {
	level: number;
	symbol: string;
	file: string;
	kind: string;
	/**
	 * Edge provenance (issue #631 B). The classification of how this
	 * edge was resolved: "resolved" for LSP-confirmed calls,
	 * "name_match" for symbol-name lookups, "heuristic" for
	 * tree-sitter-inferred references, or "unresolved" when the
	 * target could not be located. Defaulted to "heuristic" when the
	 * in-memory edge carries no provenance field.
	 */
	provenance: Provenance;
}

export interface CallChainEntry {
	symbol: { id: string; name: string; kind: string; file: string; line: number };
	incoming: CallChainEdge[];
	outgoing: CallChainEdge[];
	affectedTests: string[];
	referencedFiles: string[];
	/**
	 * Mermaid `flowchart TD` block (issue #631 B). LLM agents can
	 * embed the block directly in chat responses or docs. Limited
	 * to a small node count so the diagram stays readable; for
	 * larger graphs the field may be undefined.
	 */
	mermaid?: string;
}

export type CallChainResult = CallChainEntry[];

/**
 * #631 A: build the typed CallChainResult. Single source of truth
 * for the call-chain JSON envelope; previously the shape was
 * inlined inside _executeCallChainJson.
 */
export function _buildCallChainResult(
	graph: RepoGraph,
	symbolName: string,
	depth: number,
	direction: "incoming" | "outgoing" | "both" = "both",
): CallChainResult {
	const targets = graph.nameIndex.get(symbolName) ?? [];
	return targets.map((target) => {
		// Collect every file touched by the call chain so we can surface
		// tests in JSON output. Mirrors the text-mode collection in
		// `_executeCallChain`; see issue #635.
		const referencedFiles = new Set<string>([target.file]);
		const incoming =
			direction !== "outgoing"
				? _traceIncoming(graph, target.id, depth).map(([level, sym, edge]) => {
						referencedFiles.add(sym.file);
						return {
							level,
							symbol: sym.name,
							file: sym.file,
							kind: edge.kind,
							// #631 B: surface per-edge provenance so the
							// consumer can tell LSP-resolved callers apart
							// from tree-sitter heuristics. Edges without a
							// provenance field default to "heuristic" (see
							// DEFAULT_PROVENANCE in core/graph.ts).
							provenance: (edge.provenance ?? "heuristic") as Provenance,
						};
					})
				: [];
		const outgoing =
			direction !== "incoming"
				? _traceOutgoing(graph, target.id, depth).map(([level, sym, edge]) => {
						referencedFiles.add(sym.file);
						return {
							level,
							symbol: sym.name,
							file: sym.file,
							kind: edge.kind,
							provenance: (edge.provenance ?? "heuristic") as Provenance,
						};
					})
				: [];
		const { tests: affectedTests } = filterTestFiles([...referencedFiles]);
		const entry: CallChainEntry = {
			symbol: { id: target.id, name: target.name, kind: target.kind, file: target.file, line: target.line },
			incoming,
			outgoing,
			affectedTests,
			referencedFiles: [...referencedFiles],
		};
		// #631 B: attach a Mermaid call graph to each entry. The
		// generator is a pure function over the entry's edges, so we
		// build it once per entry and let the dispatcher emit it as
		// part of the JSON envelope.
		entry.mermaid = buildMermaidCallGraph(entry);
		return entry;
	});
}

function _executeCallChainJson(
	graph: RepoGraph,
	symbolName: string,
	depth: number,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	return buildEnvelope(
		"shazam_impact",
		getEffectiveRoot(),
		"ok",
		_buildCallChainResult(graph, symbolName, depth, direction),
	);
}

function _traceIncoming(graph: RepoGraph, startId: string, maxDepth: number): [number, Symbol, Edge][] {
	const visited = new Set<string>();
	const result: [number, Symbol, Edge][] = [];
	const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
	visited.add(startId);

	let head = 0;
	while (head < queue.length) {
		const { id, depth } = queue[head++];
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

function _traceOutgoing(graph: RepoGraph, startId: string, maxDepth: number): [number, Symbol, Edge][] {
	const visited = new Set<string>();
	const result: [number, Symbol, Edge][] = [];
	const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
	visited.add(startId);

	let head = 0;
	while (head < queue.length) {
		const { id, depth } = queue[head++];
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
	/**
	 * Edge provenance: how this reference was resolved. Surfaced so the
	 * LLM can tell LSP-confirmed calls apart from tree-sitter heuristics
	 * (issue #633). Defaults to "heuristic" when an in-memory edge was
	 * constructed without provenance.
	 */
	provenance: import("../core/graph.js").Provenance;
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
					refs.push({
						symbol: src.name,
						file: src.file,
						line: src.line,
						kind: src.kind,
						direction: "incoming",
						provenance: edge.provenance ?? "heuristic",
					});
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
					refs.push({
						symbol: tgt.name,
						file: tgt.file,
						line: tgt.line,
						kind: tgt.kind,
						direction: "outgoing",
						provenance: edge.provenance ?? "heuristic",
					});
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
			lines.push(`- ${r.kind} \`${r.symbol}\` - ${r.file}:${r.line} [${r.provenance}]`);
		if (incoming.length > MAX_DISPLAY_REFS) lines.push(`  ... and ${incoming.length - MAX_DISPLAY_REFS} more`);
		lines.push("");
	}

	if (outgoing.length > 0) {
		lines.push(`### Outgoing (${outgoing.length})`);
		for (const r of outgoing.slice(0, MAX_DISPLAY_REFS))
			lines.push(`- ${r.kind} \`${r.symbol}\` - ${r.file}:${r.line} [${r.provenance}]`);
		if (outgoing.length > MAX_DISPLAY_REFS) lines.push(`  ... and ${outgoing.length - MAX_DISPLAY_REFS} more`);
		lines.push("");
	}

	return lines.join("\n");
}

// -- Mermaid call graph (issue #631 B, slice 3.2) -------------------------

/**
 * Maximum number of nodes rendered in a single Mermaid call graph.
 * Keeps the diagram readable and bounded in size. Edges beyond the
 * cap are silently dropped (callers and callees are ranked first).
 */
const MAX_MERMAID_NODES = 30;

/**
 * Sanitize a symbol name for use as a Mermaid node identifier. Mermaid
 * is sensitive to a handful of characters in node labels, so we keep
 * the displayed label friendly and use a separate sanitized key in
 * the node declaration. Returns `{ id, label }` where `id` is a
 * Mermaid-safe token and `label` is the human-readable display text.
 *
 * Exported (without the `_` prefix) so the sanitization can be
 * unit-tested in isolation; see `tests/impact-mermaid.test.ts`.
 *
 * Security note (CodeQL `js/incomplete-sanitization`): the order
 * of the two `replace` calls matters. Backslashes MUST be escaped
 * before quotes, otherwise a raw name like `x\"y` would produce
 * `x\\"y` -- Mermaid would see `x\` inside the string and `"y"`
 * outside it, producing a malformed diagram (and, when embedded
 * in HTML, a potential XSS sink for the dangling `"y` fragment).
 */
export function mermaidSafeName(rawName: string): { id: string; label: string } {
	const id = rawName.replace(/[^A-Za-z0-9_]/g, "_");
	// Escape backslashes first, then double-quotes. The order is
	// load-bearing: a backslash that precedes a quote must be
	// doubled, otherwise the subsequent `\"` escape produces
	// `\\"` (one literal backslash, one escaped quote) which
	// Mermaid parses as `\` + end-of-string + `"y` outside.
	const label = rawName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return { id, label };
}

/**
 * Build a Mermaid `flowchart TD` block for one CallChainEntry. Edges
 * are annotated with their provenance: `resolved` shows a solid line
 * `-->`, `heuristic` shows a thin line `-->` (Mermaid's default),
 * `name_match` and `unresolved` show dashed lines `-.->`. The block
 * is capped at MAX_MERMAID_NODES symbols to keep the diagram
 * readable; larger graphs are truncated with a trailing comment.
 *
 * Pure function: no side effects, no graph mutation.
 */
export function buildMermaidCallGraph(entry: CallChainEntry): string {
	// Collect unique symbol names from incoming + outgoing edges plus
	// the entry's own symbol. Cap at MAX_MERMAID_NODES by picking the
	// most-connected symbols first.
	const neighborNames = new Set<string>();
	for (const e of entry.incoming) neighborNames.add(e.symbol);
	for (const e of entry.outgoing) neighborNames.add(e.symbol);
	neighborNames.add(entry.symbol.name);

	let names = [...neighborNames];
	// Always keep the entry's own symbol in the rendered set even
	// when neighbor count exceeds the cap, so the entry is never
	// dropped from its own call graph.
	if (names.length > MAX_MERMAID_NODES) {
		const own = entry.symbol.name;
		const trimmed = names.slice(0, MAX_MERMAID_NODES);
		if (!trimmed.includes(own)) {
			trimmed[trimmed.length - 1] = own;
		}
		names = trimmed;
	}

	// Map raw symbol name -> { mermaidId, label } for de-duplicated
	// node declarations. We also build a label map for the entry's
	// own symbol so its file can be rendered as a tooltip-style hint.
	const idFor = new Map<string, { id: string; label: string }>();
	for (const n of names) idFor.set(n, mermaidSafeName(n));

	const lines: string[] = ["flowchart TD"];

	// Node declarations
	for (const n of names) {
		const { id, label } = idFor.get(n)!;
		lines.push(`  ${id}["${label}"]`);
	}

	// Edges from the entry's own outgoing calls
	for (const e of entry.outgoing) {
		if (!idFor.has(e.symbol)) continue;
		const { id: srcId } = idFor.get(entry.symbol.name)!;
		const { id: tgtId } = idFor.get(e.symbol)!;
		lines.push(`  ${_mermaidEdge(srcId, tgtId, e.provenance)}`);
	}

	// Edges from incoming calls -- invert direction so the diagram
	// reads as "this symbol is called by ..."
	for (const e of entry.incoming) {
		if (!idFor.has(e.symbol)) continue;
		const { id: srcId } = idFor.get(e.symbol)!;
		const { id: tgtId } = idFor.get(entry.symbol.name)!;
		lines.push(`  ${_mermaidEdge(srcId, tgtId, e.provenance)}`);
	}

	if (neighborNames.size > MAX_MERMAID_NODES) {
		lines.push(`  %% truncated: ${neighborNames.size - MAX_MERMAID_NODES} more symbol(s) omitted`);
	}

	return lines.join("\n");
}

/**
 * Pick the Mermaid arrow style + label for a given edge provenance.
 * Returns the full `SRC -->|label| TGT` fragment as a tuple so the
 * caller can drop it into a line. The label embeds the provenance
 * word so consumers reading the raw text can see it without parsing
 * Mermaid syntax.
 * - resolved: solid arrow, label "resolved"
 * - heuristic: solid arrow, label "heuristic"
 * - name_match: dashed arrow, label "name_match"
 * - unresolved: dashed arrow, label "unresolved"
 */
function _mermaidEdge(srcId: string, tgtId: string, provenance: Provenance): string {
	const arrow = provenance === "name_match" || provenance === "unresolved" ? "-.->" : "-->";
	return `${srcId} ${arrow}|${provenance}| ${tgtId}`;
}

// -- Backward-compatible exports (for call_chain tests) -----------------

export function executeCallChain(
	graph: RepoGraph,
	symbolName: string,
	depth: number = 2,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	const result = _executeCallChain(graph, symbolName, depth, direction);
	// Only record the symbol as reviewed if it actually exists in the graph.
	// recordCallChain was previously called before checking symbol existence,
	// which allowed the rename safety gate to be bypassed (#569).
	const exists = (graph.nameIndex.get(symbolName)?.length ?? 0) > 0;
	if (exists) recordCallChain(symbolName);
	return result;
}

export function executeCallChainJson(
	graph: RepoGraph,
	symbolName: string,
	depth: number,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	const exists = (graph.nameIndex.get(symbolName)?.length ?? 0) > 0;
	if (exists) recordCallChain(symbolName);
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

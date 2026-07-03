/**
 * pi-shazam tools/_dispatchers -- Shared dispatch logic for all 7 tools.
 *
 * Each dispatcher is the single source of truth for parameter extraction,
 * validation, path guards, error handling, and routing/mode dispatch.
 * Both Pi tools (tools/*.ts) and MCP tools (mcp/tools.ts) call the same
 * dispatcher, eliminating dual-maintenance (root cause of #616 drift).
 *
 * Contract:
 *   Input:  (graph, params, projectRoot)
 *   Output: { text: string; isError?: boolean }
 *
 * Callers handle: graph creation (scanProject), maxTokens truncation,
 * content envelope wrapping ({ content: [{ type: "text", text }] }).
 *
 * Dispatchers do NOT call scanProject — the caller provides the graph.
 * Dispatchers do NOT handle maxTokens truncation — the caller does.
 * Exception: verify dispatch handles capVerifyDiagnostics because it is
 * tightly coupled to the verify JSON output structure.
 */
import type { RepoGraph } from "../core/graph.js";
import { executeOverview, executeOverviewJson } from "./overview.js";
import {
	executeImpact,
	executeImpactJson,
	executeCallChain,
	executeCallChainJson,
	getFlatReferences,
	formatFlatReferences,
} from "./impact.js";
import {
	executeLookupAsync,
	executeFileDetailAsync,
	executeFileDetailJson,
	executeStateMap,
	_executeSearch,
	_formatSearchResults,
	_looksLikeNaturalLanguage,
	_findSymbols,
	_executeSymbolJson,
} from "./lookup.js";
import { executeFormat, executeFormatJson } from "./format.js";
import { executeVerifyTextAsync, executeVerifyJsonAsync, capVerifyDiagnostics } from "./verify.js";
import { executeChanges, executeChangesJson } from "./changes.js";
import { executeRenameSymbol, formatRenameResult } from "./rename_symbol.js";
import { hasCallChainChecked, recordCallChain } from "./rename-state.js";
import { validatePathInProject, buildEnvelope } from "./_factory.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

// -- Dispatcher result type -----------------------------------------------

export interface DispatchResult {
	text: string;
	isError?: boolean;
}

// -- shazam_overview ------------------------------------------------------

export function dispatchOverview(
	graph: RepoGraph,
	params: Record<string, unknown>,
	projectRoot: string,
): DispatchResult {
	const filter = (params.filter as string) ?? "";
	const json = (params.json as boolean) ?? false;
	const text = json ? executeOverviewJson(graph, projectRoot, filter) : executeOverview(graph, projectRoot, filter);
	return { text };
}

// -- shazam_lookup --------------------------------------------------------

/**
 * Heuristic: detect whether a name looks like a file path rather than a symbol.
 * Shared between Pi and MCP — extracted from tools/lookup.ts _isFilePath.
 */
export function _isFilePath(name: string): boolean {
	return (
		name.includes("/") ||
		name.includes("\\") ||
		/\.(ts|tsx|js|jsx|py|go|rs|dart|json|yaml|yml|mjs|cjs|rb|java|cs|c|cpp|h|hpp|css|scss|less|sh|bash|toml|html|htm|md)$/.test(
			name,
		)
	);
}

export async function dispatchLookup(
	graph: RepoGraph,
	params: Record<string, unknown>,
	projectRoot: string,
): Promise<DispatchResult> {
	const nameStr = params.name as string;
	if (!nameStr) {
		return { text: "Error: name parameter is required", isError: true };
	}

	const json = (params.json as boolean) ?? false;
	const mode = (params.mode as string) ?? "default";

	// Path traversal guard: reject file paths outside project root.
	// #616: check nameIndex before validatePathInProject — symbols that
	// look like file paths (e.g. "config.json") must not be rejected when
	// they exist in the graph (matching Pi native behavior, issue #497).
	if (_isFilePath(nameStr) && !graph.nameIndex?.has(nameStr) && !validatePathInProject(nameStr, projectRoot)) {
		return {
			text: buildEnvelope("shazam_lookup", projectRoot, "error", {
				error: `Path '${nameStr}' is outside the project root and cannot be read.`,
			}),
			isError: true,
		};
	}

	const fileParam = params.file as string | undefined;
	if (fileParam && !validatePathInProject(fileParam, projectRoot)) {
		return {
			text: buildEnvelope("shazam_lookup", projectRoot, "error", {
				error: `File path '${fileParam}' is outside the project root.`,
			}),
			isError: true,
		};
	}

	let text: string;

	// #598: Verify file-path mode with existsSync, not just regex.
	// A symbol name like "foo.ts" matches the file-extension regex
	// but is not a real file on disk — it must fall through to
	// symbol-lookup mode instead.
	// #616: also check nameIndex first — when a name exists both as
	// a symbol in the graph AND as a file on disk, Pi native routes to
	// symbol mode (symbol-first heuristic).
	if (_isFilePath(nameStr) && !graph.nameIndex?.has(nameStr) && existsSync(join(projectRoot, nameStr))) {
		text = json ? executeFileDetailJson(graph, nameStr) : await executeFileDetailAsync(graph, nameStr);
	} else if (mode === "state") {
		text = executeStateMap(graph, nameStr);
		if (json) {
			text = buildEnvelope("shazam_lookup", projectRoot, "ok", {
				symbol: nameStr,
				mode: "state",
				text,
			});
		}
	} else if (mode === "search") {
		const results = _executeSearch(graph, nameStr);
		if (json) {
			text = buildEnvelope("shazam_lookup", projectRoot, "ok", {
				mode: "search",
				query: nameStr,
				results,
			});
		} else {
			text = _formatSearchResults(nameStr, results);
		}
	} else {
		// Default: symbol lookup. If not found and input looks like natural
		// language (multi-word concept query), auto-fallback to search (#490).
		const matches = _findSymbols(graph, nameStr, fileParam);
		if (matches.length === 0 && _looksLikeNaturalLanguage(nameStr)) {
			const results = _executeSearch(graph, nameStr);
			if (json) {
				text = buildEnvelope("shazam_lookup", projectRoot, "ok", {
					mode: "search",
					query: nameStr,
					results,
				});
			} else {
				text = _formatSearchResults(nameStr, results);
			}
		} else {
			text = json
				? _executeSymbolJson(graph, nameStr, fileParam)
				: await executeLookupAsync(
						graph,
						nameStr,
						fileParam,
						(params.direction as "both" | "supertypes" | "subtypes") ?? "both",
						(params.showCallbacks as boolean) ?? false,
					);
		}
	}

	return { text };
}

// -- shazam_impact --------------------------------------------------------

export function dispatchImpact(graph: RepoGraph, params: Record<string, unknown>, projectRoot: string): DispatchResult {
	const json = (params.json as boolean) ?? false;
	const depth = Math.min(Math.max((params.depth as number) ?? 3, 1), 10);
	const direction = (params.direction as "incoming" | "outgoing" | "both") ?? "both";
	const symbolName = params.symbol as string | undefined;

	// #616: reject when both --symbol and --files are provided.
	// Pi native returns an explicit error; MCP previously silently
	// took the --symbol path and discarded --files without warning.
	const filesArr = params.files as string[] | undefined;
	if (symbolName && filesArr && filesArr.length > 0) {
		return {
			text: "Error: --symbol and --files are mutually exclusive. Use --symbol for call chain analysis or --files for impact analysis, not both.",
			isError: true,
		};
	}

	// Symbol mode: call chain analysis
	if (symbolName) {
		// #447: Record that impact --symbol was run so the rename gate is satisfied
		recordCallChain(symbolName);
		const flat = (params.flat as boolean) ?? false;
		if (flat) {
			const refs = getFlatReferences(graph, symbolName, direction);
			const text = json
				? buildEnvelope("shazam_impact", projectRoot, "ok", refs)
				: formatFlatReferences(refs, symbolName);
			return { text };
		}
		const text = json
			? executeCallChainJson(graph, symbolName, depth, direction)
			: executeCallChain(graph, symbolName, depth, direction);
		return { text };
	}

	// File mode: impact analysis
	if (!filesArr || filesArr.length === 0) {
		return {
			text: "Error: either --files (array of file paths) or --symbol (symbol name) is required",
			isError: true,
		};
	}
	// #445: Validate user-supplied file paths against project root (path-traversal guard)
	for (const f of filesArr) {
		if (!validatePathInProject(f, projectRoot)) {
			return {
				text: `Error: File path '${f}' is outside the project root and cannot be accessed.`,
				isError: true,
			};
		}
	}

	const text = json
		? executeImpactJson(graph, filesArr, depth)
		: executeImpact(graph, filesArr, {
				withSymbols: (params.withSymbols as boolean) ?? false,
				compact: (params.compact as boolean) ?? false,
				depth,
			});
	return { text };
}

// -- shazam_verify --------------------------------------------------------

export async function dispatchVerify(
	_graph: RepoGraph | undefined,
	params: Record<string, unknown>,
	projectRoot: string,
): Promise<DispatchResult> {
	const json = (params.json as boolean) ?? false;
	const maxTokens = params.maxTokens as number | undefined;

	// #616: reset scanner cache before verify — Pi native forces a
	// fresh scan because verify must always see current file state.
	// MCP is long-lived; cache from prior tool calls would stale results.
	const { resetCache } = await import("../core/scanner.js");
	resetCache();

	const opts = {
		quick: (params.quick as boolean) ?? false,
		lspOnly: (params.lspOnly as boolean) ?? false,
		preCommit: (params.preCommit as boolean) ?? false,
		maxFiles: (params.maxFiles as number | undefined) ?? 100,
		noCascade: (params.noCascade as boolean) ?? false,
		noSecrets: (params.noSecrets as boolean) ?? false,
	};

	if (json) {
		const result = await executeVerifyJsonAsync(projectRoot, opts);
		const envelope = {
			schema_version: "1.0",
			command: "verify",
			project: projectRoot,
			status: "ok",
			result,
		};
		let text = JSON.stringify(envelope);
		// #616: cap lspDiagnostics when JSON output exceeds maxTokens,
		// matching Pi native capVerifyDiagnostics behavior.
		if (capVerifyDiagnostics(result, text, maxTokens)) {
			text = JSON.stringify(envelope);
		}
		return { text };
	}

	const text = await executeVerifyTextAsync(projectRoot, opts);
	return { text };
}

// -- shazam_changes -------------------------------------------------------

export function dispatchChanges(
	graph: RepoGraph,
	params: Record<string, unknown>,
	projectRoot: string,
): DispatchResult {
	const json = (params.json as boolean) ?? false;
	const text = json ? executeChangesJson(graph, projectRoot) : executeChanges(graph, projectRoot);
	return { text };
}

// -- shazam_format --------------------------------------------------------

export async function dispatchFormat(
	graph: RepoGraph,
	params: Record<string, unknown>,
	projectRoot: string,
): Promise<DispatchResult> {
	const json = (params.json as boolean) ?? false;
	const dryRun = (params.dryRun as boolean) ?? true;
	const file = params.file as string | undefined;

	// #465: validate user-supplied file path against project root.
	if (file && !validatePathInProject(file, projectRoot)) {
		return {
			text: json
				? JSON.stringify({
						schema_version: "1.0",
						command: "format",
						project: projectRoot,
						status: "error",
						result: { error: "file path escapes project root" },
					})
				: "Error: file path escapes project root",
			isError: true,
		};
	}

	const text = json
		? await executeFormatJson(graph, projectRoot, { dryRun, file })
		: await executeFormat(graph, projectRoot, { dryRun, file });
	return { text };
}

// -- shazam_rename_symbol -------------------------------------------------

export async function dispatchRenameSymbol(
	graph: RepoGraph,
	params: Record<string, unknown>,
	projectRoot: string,
): Promise<DispatchResult> {
	const json = (params.json as boolean) ?? false;
	const symbolName = typeof params.symbol === "string" ? params.symbol : "";
	const newName = typeof params.newName === "string" ? params.newName : "";
	const dryRun = (params.dryRun as boolean) ?? true;

	if (!symbolName) {
		return { text: "Error: symbol parameter is required", isError: true };
	}
	if (!newName) {
		return { text: "Error: newName parameter is required", isError: true };
	}

	// Block non-dry-run unless shazam_impact --symbol was run for this symbol (issue #326)
	if (!dryRun && !hasCallChainChecked(symbolName)) {
		return {
			text: [
				"[BLOCKED] Rename aborted - shazam_impact --symbol has not been run for this symbol.",
				"",
				`Before renaming \`${symbolName}\`, you MUST run:`,
				`  shazam_impact --symbol "${symbolName}" --direction both`,
				"",
				"Review all callers and callees, then re-invoke shazam_rename_symbol with dryRun=false.",
			].join("\n"),
			isError: true,
		};
	}

	const result = await executeRenameSymbol(graph, symbolName, newName, dryRun, projectRoot);
	const text = json
		? buildEnvelope("shazam_rename_symbol", projectRoot, "ok", result)
		: formatRenameResult(result, symbolName, newName, dryRun);
	return { text };
}

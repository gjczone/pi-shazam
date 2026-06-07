/**
 * pi-shazam tools/lsp_enrich — Tool-layer wrappers for LSP enrichment.
 *
 * Provides helpers that tools/ call to enrich tree-sitter graph data
 * with LSP results (workspace/symbol, documentSymbol, semanticTokens,
 * foldingRange). Each helper:
 *   - Returns null/empty on any failure (timeout, no server, file not opened)
 *   - Never throws into tool code
 *   - Runs within a configurable timeout (default 5000ms)
 *
 * Layer rule: tools/ -> lsp/ is allowed. core/ -> lsp/ is NOT.
 * These helpers live here to preserve that boundary.
 */
import type { LspClient } from "../lsp/client.js";
import { uriToPath } from "../lsp/client.js";
import { readFileAdaptive } from "../core/encoding.js";
import type {
	SymbolInformation,
	WorkspaceSymbol,
	DocumentSymbol,
	SemanticTokens,
	FoldingRange,
	Location,
} from "vscode-languageserver-protocol";

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_LSP_ENRICH_TIMEOUT_MS = 5000;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal LspManager-like surface used by helpers.
 * Accepts the real LspManager or a test stub.
 */
export interface LspEnrichContext {
	getServerForFile(filePath: string): {
		language: string;
		client: LspClient;
		workspaceRoot: string;
	} | null;
	getActiveServers(): {
		language: string;
		client: LspClient;
		workspaceRoot: string;
	}[];
}

export interface EnrichedSymbolHit {
	name: string;
	kind: string;
	file: string;
	line: number;
	endLine: number;
	col: number;
	endCol: number;
	containerName?: string;
	source: "lsp";
}

// ── Timeout helper ───────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout. Returns null on timeout.
 */
export function withEnrichTimeout<T>(
	promise: Promise<T | null | undefined>,
	ms: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<T | null> {
	return new Promise<T | null>((resolve) => {
		const timer = setTimeout(() => {
			// Silence the original promise to prevent unhandled rejections
			// if it resolves/rejects after timeout.
			void promise.catch(() => {});
			resolve(null);
		}, ms);
		promise
			.then((v) => {
				clearTimeout(timer);
				resolve(v ?? null);
			})
			.catch(() => {
				clearTimeout(timer);
				resolve(null);
			});
	});
}

// ── SymbolKind mapping ───────────────────────────────────────────────────────

/**
 * Map LSP SymbolKind numeric enum (1..26) to the string kind values
 * used by core/graph.ts. Unknown values fall back to "symbol".
 */
export function mapSymbolKindNumber(kind: number): string {
	switch (kind) {
		case 1:
			return "file";
		case 2:
			return "module";
		case 3:
			return "namespace";
		case 4:
			return "package";
		case 5:
			return "class";
		case 6:
			return "method";
		case 7:
			return "property";
		case 8:
			return "field";
		case 9:
			return "constructor";
		case 10:
			return "enum";
		case 11:
			return "interface";
		case 12:
			return "function";
		case 13:
			return "variable";
		case 14:
			return "constant";
		case 15:
			return "string";
		case 16:
			return "number";
		case 17:
			return "boolean";
		case 18:
			return "array";
		case 19:
			return "object";
		case 20:
			return "key";
		case 21:
			return "null";
		case 22:
			return "enum_member";
		case 23:
			return "struct";
		case 24:
			return "event";
		case 25:
			return "operator";
		case 26:
			return "type_alias";
		default:
			return "symbol";
	}
}

// ── File opening helper ──────────────────────────────────────────────────────

/**
 * Ensure a file is opened in its LSP server (best-effort, swallow errors).
 * Reads file content via fs and sends didOpen if not already opened.
 */
export async function ensureFileOpened(
	ctx: LspEnrichContext,
	filePath: string,
): Promise<{ client: LspClient; workspaceRoot: string } | null> {
	const info = ctx.getServerForFile(filePath);
	if (!info) return null;
	if (!info.client.isRunning()) return null;
	try {
		if (!info.client.isFileOpened(filePath)) {
			const { resolve } = await import("node:path");
			const absPath = resolve(info.workspaceRoot, filePath);
			const content = readFileAdaptive(absPath);
			await info.client.didOpen(filePath, content);
		}
	} catch {
		return null;
	}
	return { client: info.client, workspaceRoot: info.workspaceRoot };
}

// ── workspace/symbol ─────────────────────────────────────────────────────────

/**
 * Query workspace/symbol across all active LSP servers.
 * Returns merged results. Empty array if no server or timeout.
 */
export async function lspWorkspaceSearch(
	ctx: LspEnrichContext | null,
	query: string,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<EnrichedSymbolHit[]> {
	if (!ctx) return [];
	const servers = ctx.getActiveServers();
	if (servers.length === 0) return [];

	const promises = servers.map(async (srv): Promise<EnrichedSymbolHit[]> => {
		if (!srv.client.isRunning()) return [];
		const cap = srv.client.serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).workspaceSymbolProvider) {
			return [];
		}
		try {
			const raw = await withEnrichTimeout(srv.client.workspaceSymbol(query), timeoutMs);
			if (!raw) return [];
			return raw.map((s) => toEnrichedHit(s)).filter(Boolean) as EnrichedSymbolHit[];
		} catch {
			return [];
		}
	});

	const settled = await Promise.allSettled(promises);
	const out: EnrichedSymbolHit[] = [];
	for (const r of settled) {
		if (r.status === "fulfilled") {
			for (const hit of r.value) out.push(hit);
		}
	}
	return out;
}

function toEnrichedHit(s: SymbolInformation | WorkspaceSymbol): EnrichedSymbolHit | null {
	const kind = mapSymbolKindNumber(s.kind);
	if ("location" in s && s.location) {
		const loc = s.location as Location;
		if (!loc.range) return null;
		const file = uriToPath(loc.uri);
		return {
			name: s.name,
			kind,
			file,
			line: loc.range.start.line + 1,
			endLine: loc.range.end.line + 1,
			col: loc.range.start.character + 1,
			endCol: loc.range.end.character + 1,
			containerName: "containerName" in s ? (s.containerName as string | undefined) : undefined,
			source: "lsp",
		};
	}
	return null;
}

// ── documentSymbol enrichment ────────────────────────────────────────────────

/**
 * Fetch LSP documentSymbol hierarchy for a file.
 * Returns null on timeout, no server, or file not opened.
 */
export async function lspDocumentSymbols(
	ctx: LspEnrichContext | null,
	filePath: string,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
	if (!ctx) return null;
	const opened = await ensureFileOpened(ctx, filePath);
	if (!opened) return null;
	const cap = opened.client.serverCapabilities;
	if (!cap || !(cap as Record<string, unknown>).documentSymbolProvider) {
		return null;
	}
	return withEnrichTimeout(opened.client.documentSymbols(filePath), timeoutMs);
}

// ── semanticTokens ───────────────────────────────────────────────────────────

/**
 * Fetch full semantic tokens for a file.
 * Returns null on timeout, no server, unsupported, or file not opened.
 */
export async function lspSemanticTokens(
	ctx: LspEnrichContext | null,
	filePath: string,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<SemanticTokens | null> {
	if (!ctx) return null;
	const opened = await ensureFileOpened(ctx, filePath);
	if (!opened) return null;
	const cap = opened.client.serverCapabilities;
	const stProvider = (cap as Record<string, unknown> | undefined)?.semanticTokensProvider;
	if (!stProvider) return null;
	return withEnrichTimeout(opened.client.semanticTokens(filePath), timeoutMs);
}

// ── foldingRange ─────────────────────────────────────────────────────────────

/**
 * Fetch folding ranges for a file.
 * Returns null on timeout, no server, unsupported, or file not opened.
 */
export async function lspFoldingRanges(
	ctx: LspEnrichContext | null,
	filePath: string,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<FoldingRange[] | null> {
	if (!ctx) return null;
	const opened = await ensureFileOpened(ctx, filePath);
	if (!opened) return null;
	const cap = opened.client.serverCapabilities;
	if (!cap || !(cap as Record<string, unknown>).foldingRangeProvider) {
		return null;
	}
	return withEnrichTimeout(opened.client.foldingRange(filePath), timeoutMs);
}

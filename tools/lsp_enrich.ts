/**
 * pi-shazam tools/lsp_enrich -- Tool-layer wrappers for LSP enrichment.
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
import { readFileAdaptiveAsync } from "../core/encoding.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import type {
	SymbolInformation,
	WorkspaceSymbol,
	DocumentSymbol,
	Location,
	LocationLink,
	CodeAction,
	SignatureHelp,
	CodeLens,
} from "vscode-languageserver-protocol";
import type { Command } from "vscode-languageserver-protocol";

const _require = createRequire(import.meta.url);
const _ctsCtor = (
	_require("vscode-jsonrpc/node") as {
		CancellationTokenSource: new () => {
			token: import("vscode-jsonrpc").CancellationToken;
			cancel(): void;
			dispose(): void;
		};
	}
).CancellationTokenSource;
type CtsInstance = InstanceType<typeof _ctsCtor>;

// -- Constants ----------------------------------------------------------------

export const DEFAULT_LSP_ENRICH_TIMEOUT_MS = 5000;

// Extended timeout for the first enrichment request after didOpen.
// Large projects may need more time for the server to index the file.
export const FIRST_ENRICH_TIMEOUT_MS = 10000;

/**
 * Compute the effective timeout: use FIRST_ENRICH_TIMEOUT_MS for the first
 * request after didOpen (when justOpened is true), unless the caller provided
 * an explicit non-default timeout.
 */
function effectiveTimeout(justOpened: boolean, timeoutMs: number): number {
	if (justOpened && timeoutMs === DEFAULT_LSP_ENRICH_TIMEOUT_MS) {
		return FIRST_ENRICH_TIMEOUT_MS;
	}
	return timeoutMs;
}

// -- Types --------------------------------------------------------------------

/**
 * Minimal LspManager-like surface used by helpers.
 * Accepts the real LspManager or a test stub.
 */
export interface LspEnrichContext {
	getServerForFile(filePath: string): Promise<{
		language: string;
		client: LspClient;
		workspaceRoot: string;
	} | null>;
	getActiveServers(): {
		language: string;
		client: LspClient;
		workspaceRoot: string;
	}[];
	trackOpenedFile(language: string, filePath: string): void;
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

// -- Timeout helper -----------------------------------------------------------

/**
 * Race a promise against a timeout. Returns null on timeout.
 * Accepts an optional CancellationTokenSource; on timeout the CTS is
 * cancelled so the underlying LSP request can free server resources.
 */
function withEnrichTimeout<T>(
	promise: Promise<T | null | undefined>,
	ms: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
	cts?: CtsInstance | undefined,
): Promise<T | null> {
	return new Promise<T | null>((resolve) => {
		const timer = setTimeout(() => {
			// Cancel the underlying LSP request to free server resources
			cts?.cancel();
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

// -- SymbolKind mapping -------------------------------------------------------

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

// -- LocationLink type guard --------------------------------------------------

/**
 * Narrow an array of Location | LocationLink to LocationLink[].
 * LSP implementation/references responses may return either type;
 * LocationLink has `targetUri` while Location has `uri`.
 */
function isLocationLinkArray(arr: unknown[]): arr is LocationLink[] {
	return arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null && "targetUri" in arr[0];
}

// -- File opening helper ------------------------------------------------------

// Upper bound: prevents _openedFileMtimes from growing unbounded in long sessions (issue #368).
const MAX_OPENED_MTIMES = 500;

// Track file modification times for opened files to detect edits.
const _openedFileMtimes = new Map<string, number>();

/** Evict the oldest entry when the upper bound is exceeded (Map iteration order = insertion order, oldest = first inserted). */
function _evictOldestMtime(): void {
	if (_openedFileMtimes.size > MAX_OPENED_MTIMES) {
		const oldest = _openedFileMtimes.keys().next().value;
		if (oldest !== undefined) _openedFileMtimes.delete(oldest);
	}
}

/**
 * Ensure a file is opened in its LSP server (best-effort, swallow errors).
 * Reads file content via fs.promises and sends didOpen if not already opened.
 * If the file was already opened but its mtime changed, sends didChange.
 * Returns `justOpened: true` when didOpen was called (first request needs more time).
 * Callers MUST validate filePath is within project root before calling.
 */
export async function ensureFileOpened(
	ctx: LspEnrichContext,
	filePath: string,
): Promise<{ client: LspClient; workspaceRoot: string; justOpened: boolean } | null> {
	const info = await ctx.getServerForFile(filePath);
	if (!info) return null;
	if (!info.client.isRunning()) return null;
	try {
		const absPath = resolve(info.workspaceRoot, filePath);

		if (!info.client.isFileOpened(filePath)) {
			const content = await readFileAdaptiveAsync(absPath);
			await info.client.didOpen(filePath, content);
			// Track for crash recovery so the file can be re-opened after server restart
			ctx.trackOpenedFile(info.language, filePath);
			// Track the mtime after opening
			const fileStat = await stat(absPath);
			_openedFileMtimes.set(filePath, fileStat.mtimeMs);
			_evictOldestMtime();
			return { client: info.client, workspaceRoot: info.workspaceRoot, justOpened: true };
		} else {
			// File already opened -- check if mtime changed
			const fileStat = await stat(absPath);
			const currentMtime = fileStat.mtimeMs;
			const prevMtime = _openedFileMtimes.get(filePath);
			if (prevMtime === undefined || currentMtime > prevMtime) {
				const content = await readFileAdaptiveAsync(absPath);
				await info.client.didChange(filePath, content);
				_openedFileMtimes.set(filePath, currentMtime);
				_evictOldestMtime();
			}
		}
	} catch (err) {
		console.warn(`[pi-shazam] ensureFileOpened: failed for ${filePath}`, err);
		return null;
	}
	return { client: info.client, workspaceRoot: info.workspaceRoot, justOpened: false };
}

// -- workspace/symbol ---------------------------------------------------------

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
			const cts = new _ctsCtor();
			const raw = await withEnrichTimeout(
				srv.client.workspaceSymbol(query, cts.token).then((r) => (r.status === "ok" ? r.data : null)),
				timeoutMs,
				cts,
			).finally(() => cts.dispose());
			if (!raw) return [];
			return raw.map((s) => toEnrichedHit(s)).filter(Boolean) as EnrichedSymbolHit[];
		} catch (err) {
			console.warn(`[pi-shazam] lspWorkspaceSearch: workspace/symbol failed for ${srv.language}`, err);
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

// -- documentSymbol enrichment ------------------------------------------------

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
	const cts = new _ctsCtor();
	const result = await withEnrichTimeout(
		opened.client.documentSymbols(filePath, cts.token).then((r) => (r.status === "ok" ? r.data : null)),
		effectiveTimeout(opened.justOpened, timeoutMs),
		cts,
	).finally(() => cts.dispose());
	return result;
}

/**
 * Reset module-level state. Called on session shutdown to prevent memory leaks.
 */
export function resetLspEnrichState(): void {
	_openedFileMtimes.clear();
}

// -- codeAction --------------------------------------------------------------

/**
 * Fetch LSP code actions for a diagnostic range.
 * Returns null on timeout, no server, or file not opened.
 */
export async function lspCodeActions(
	ctx: LspEnrichContext | null,
	filePath: string,
	startLine: number,
	startChar: number,
	endLine: number,
	endChar: number,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<(CodeAction | Command)[] | null> {
	if (!ctx) return null;
	const opened = await ensureFileOpened(ctx, filePath);
	if (!opened) return null;
	const cap = opened.client.serverCapabilities;
	if (!cap || !(cap as Record<string, unknown>).codeActionProvider) {
		return null;
	}
	const cts = new _ctsCtor();
	const result = await withEnrichTimeout(
		opened.client
			.codeAction(filePath, startLine, startChar, endLine, endChar, cts.token)
			.then((r) => (r.status === "ok" ? r.data : null)),
		effectiveTimeout(opened.justOpened, timeoutMs),
		cts,
	).finally(() => cts.dispose());
	return result;
}

// -- signatureHelp -----------------------------------------------------------

/**
 * Fetch LSP signature help at a position.
 * Returns null on timeout, no server, or file not opened.
 */
export async function lspSignatureHelp(
	ctx: LspEnrichContext | null,
	filePath: string,
	line: number,
	character: number,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<SignatureHelp | null> {
	if (!ctx) return null;
	const opened = await ensureFileOpened(ctx, filePath);
	if (!opened) return null;
	const cap = opened.client.serverCapabilities;
	if (!cap || !(cap as Record<string, unknown>).signatureHelpProvider) {
		return null;
	}
	const cts = new _ctsCtor();
	const result = await withEnrichTimeout(
		opened.client.signatureHelp(filePath, line, character, cts.token).then((r) => (r.status === "ok" ? r.data : null)),
		effectiveTimeout(opened.justOpened, timeoutMs),
		cts,
	).finally(() => cts.dispose());
	return result;
}

// -- implementation ----------------------------------------------------------

/**
 * Fetch LSP implementation locations for a symbol at a position.
 * Returns null on timeout, no server, or file not opened.
 * Handles both Location[] and LocationLink[] responses.
 */
export async function lspImplementation(
	ctx: LspEnrichContext | null,
	filePath: string,
	line: number,
	character: number,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<Location[] | null> {
	if (!ctx) return null;
	const opened = await ensureFileOpened(ctx, filePath);
	if (!opened) return null;
	const cap = opened.client.serverCapabilities;
	if (!cap || !(cap as Record<string, unknown>).implementationProvider) {
		return null;
	}
	const cts = new _ctsCtor();
	const result = await withEnrichTimeout(
		opened.client.implementation(filePath, line, character, cts.token).then((r) => {
			if (r.status !== "ok" || !r.data) return null;
			const arr: unknown[] = Array.isArray(r.data) ? r.data : [r.data];
			// Detect LocationLink[] by checking for "targetUri" property
			if (isLocationLinkArray(arr)) {
				return arr.map(
					(ll) =>
						({
							uri: ll.targetUri,
							range: ll.targetRange,
						}) as Location,
				);
			}
			return arr as Location[];
		}),
		effectiveTimeout(opened.justOpened, timeoutMs),
		cts,
	).finally(() => cts.dispose());
	return result;
}

/**
 * Fetch LSP references for a symbol at a position.
 * Returns null on timeout, no server, or file not opened.
 * Handles both Location[] and LocationLink[] responses.
 */
export async function lspReferences(
	ctx: LspEnrichContext | null,
	filePath: string,
	line: number,
	character: number,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<Location[] | null> {
	if (!ctx) return null;
	const opened = await ensureFileOpened(ctx, filePath);
	if (!opened) return null;
	const cap = opened.client.serverCapabilities;
	if (!cap || !(cap as Record<string, unknown>).referencesProvider) {
		return null;
	}
	const cts = new _ctsCtor();
	const result = await withEnrichTimeout(
		opened.client.references(filePath, line, character, cts.token).then((r) => {
			if (r.status !== "ok" || !r.data) return null;
			const arr: unknown[] = Array.isArray(r.data) ? r.data : [r.data];
			// Detect LocationLink[] by checking for "targetUri" property
			if (isLocationLinkArray(arr)) {
				return arr.map(
					(ll) =>
						({
							uri: ll.targetUri,
							range: ll.targetRange,
						}) as Location,
				);
			}
			return arr as Location[];
		}),
		effectiveTimeout(opened.justOpened, timeoutMs),
		cts,
	).finally(() => cts.dispose());
	return result;
}

// -- codeLens ----------------------------------------------------------------

/**
 * Fetch LSP codeLens for a file (reference counts, test status, etc.).
 * Returns null on timeout, no server, or file not opened.
 */
export async function lspCodeLens(
	ctx: LspEnrichContext | null,
	filePath: string,
	timeoutMs: number = DEFAULT_LSP_ENRICH_TIMEOUT_MS,
): Promise<CodeLens[] | null> {
	if (!ctx) return null;
	const opened = await ensureFileOpened(ctx, filePath);
	if (!opened) return null;
	const cap = opened.client.serverCapabilities;
	if (!cap || !(cap as Record<string, unknown>).codeLensProvider) {
		return null;
	}
	const cts = new _ctsCtor();
	const result = await withEnrichTimeout(
		opened.client.codeLens(filePath, cts.token).then((r) => (r.status === "ok" ? r.data : null)),
		effectiveTimeout(opened.justOpened, timeoutMs),
		cts,
	).finally(() => cts.dispose());
	return result;
}

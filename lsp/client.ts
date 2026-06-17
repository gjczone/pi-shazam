/**
 * pi-shazam lsp/client — LSP protocol communication (JSON-RPC over stdio).
 *
 * Uses vscode-jsonrpc/node for wire protocol handling
 * (StreamMessageReader / StreamMessageWriter + createMessageConnection).
 *
 * Ported from repomap/src/lsp.py (StdioLspClient).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

// vscode-jsonrpc/node exports for LSP client over stdio
const rpc: {
	StreamMessageReader: new (stream: NodeJS.ReadableStream) => import("vscode-jsonrpc").MessageReader;
	StreamMessageWriter: new (stream: NodeJS.WritableStream) => import("vscode-jsonrpc").MessageWriter;
	createMessageConnection: (
		reader: import("vscode-jsonrpc").MessageReader,
		writer: import("vscode-jsonrpc").MessageWriter,
		logger?: import("vscode-jsonrpc").Logger,
	) => import("vscode-jsonrpc").MessageConnection;
	CancellationTokenSource: new () => {
		token: import("vscode-jsonrpc").CancellationToken;
		cancel(): void;
		dispose(): void;
	};
} = _require("vscode-jsonrpc/node");

import type {
	InitializeParams,
	InitializeResult,
	DidOpenTextDocumentParams,
	DidChangeTextDocumentParams,
	DidSaveTextDocumentParams,
	Location,
	PublishDiagnosticsParams,
	DocumentSymbolParams,
	DefinitionParams,
	ReferenceParams,
	HoverParams,
	Hover,
	SymbolInformation,
	DocumentSymbol,
	WorkspaceSymbolParams,
	WorkspaceSymbol,
	SemanticTokensParams,
	SemanticTokens,
	FoldingRangeParams,
	FoldingRange,
	WorkspaceEdit,
	CodeActionParams,
	CodeAction,
	SignatureHelpParams,
	SignatureHelp,
	ImplementationParams,
	CodeLensParams,
	CodeLens,
} from "vscode-languageserver-protocol";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_LSP_FILE_SIZE = 1_048_576; // 1 MiB

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Discriminated union for LSP protocol method results.
 * Callers can distinguish "no data" (status: "ok", data: null) from
 * "server error/timeout" (status: "error") instead of both returning null.
 */
export interface LspOk<T> {
	status: "ok";
	data: T | null;
}

export interface LspErr {
	status: "error";
	reason: string;
	timeout: boolean;
}

export type LspResult<T> = LspOk<T> | LspErr;

export interface LspDiagnostic {
	file: string;
	line: number;
	col: number;
	endLine: number;
	endCol: number;
	severity: "error" | "warning" | "info" | "hint";
	code: string;
	message: string;
	source: string;
}

export interface LspLocation {
	file: string;
	line: number;
	col: number;
	endLine: number;
	endCol: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pathToUri(filePath: string): string {
	const resolved = path.resolve(filePath);
	// file:// URI with absolute path, percent-encoding special characters
	const normalized = resolved.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
	if (normalized[0] !== "/") {
		return `file:///${normalized}`;
	}
	return `file://${normalized}`;
}

export function uriToPath(uri: string): string {
	if (uri.startsWith("file://")) {
		let p = uri.slice("file://".length);
		if (!p.startsWith("/")) {
			p = "/" + p;
		}
		try {
			return decodeURIComponent(p);
		} catch {
			// Log the raw path for debugging (silent fallback is confusing)
			console.warn(`[pi-shazam] uriToPath: decodeURIComponent failed for URI: ${uri.slice(0, 200)}`);
			return p;
		}
	}
	return uri;
}

function severityName(value: number | undefined | null): LspDiagnostic["severity"] {
	if (value === 1) return "error";
	if (value === 2) return "warning";
	if (value === 3) return "info";
	if (value === 4) return "hint";
	return "warning";
}

function lspLanguageId(language: string, filePath: string): string {
	const suffix = path.extname(filePath).toLowerCase();
	if (language === "typescript") {
		if (suffix === ".tsx") return "typescriptreact";
		if (suffix === ".jsx") return "javascriptreact";
		if ([".js", ".mjs", ".cjs"].includes(suffix)) return "javascript";
		return "typescript";
	}
	return language;
}

// ── LspClient ────────────────────────────────────────────────────────────────

export class LspClient {
	readonly command: readonly string[];
	readonly workspaceRoot: string;
	readonly timeout: number;

	private process: ChildProcess | null = null;
	private connection: import("vscode-jsonrpc").MessageConnection | null = null;
	private _openedFiles = new Set<string>();
	private _openingFiles = new Set<string>();
	private _serverCapabilities: Record<string, unknown> = {};
	private _running = false;
	private _initialized = false;
	private _initPromise: Promise<void> | null = null;
	private _closing = false;
	private _closePromise: Promise<void> | null = null;
	private _log: (msg: string) => void;

	// Store notifications (e.g., diagnostics) received outside request-response.
	// Deduplicated per URI: only the latest notification per URI is kept.
	private _notifications: PublishDiagnosticsParams[] = [];

	// Track in-flight LSP requests with their reject callbacks so close()
	// can cancel all pending requests.
	private _inFlightRequests = new Map<Promise<unknown>, (err: Error) => void>();

	constructor(command: readonly string[], workspaceRoot: string, timeout: number = 8000, log?: (msg: string) => void) {
		this.command = command;
		this.workspaceRoot = workspaceRoot;
		this.timeout = timeout;
		this._log = log ?? (() => {});
	}

	// ── State ──────────────────────────────────────────────────────────────────

	isRunning(): boolean {
		return this._running;
	}

	isInitialized(): boolean {
		return this._initialized;
	}

	isFileOpened(filePath: string): boolean {
		return this._openedFiles.has(this.resolveRel(filePath));
	}

	get serverCapabilities(): Record<string, unknown> {
		return this._serverCapabilities;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	start(): void {
		if (this._running) return;

		this._log(`Starting LSP: ${this.command[0]} (workspace: ${this.workspaceRoot})`);

		const [cmd, ...args] = this.command;
		this.process = spawn(cmd!, args, {
			cwd: this.workspaceRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.process.on("error", (err) => {
			this._log(`LSP process error: ${err.message}`);
			this._cleanupAfterCrash();
		});

		this.process.on("exit", (code, signal) => {
			this._log(`LSP process exited: code=${code}, signal=${signal}`);
			this._cleanupAfterCrash();
		});

		// Drain stderr to prevent deadlock
		if (this.process.stderr) {
			this.process.stderr.on("data", (chunk: Buffer) => {
				this._log(`LSP stderr: ${chunk.toString("utf-8", 0, Math.min(chunk.length, 500))}`);
			});
		}

		// Create JSON-RPC connection over stdio
		const reader = new rpc.StreamMessageReader(this.process.stdout!);
		const writer = new rpc.StreamMessageWriter(this.process.stdin!);
		this.connection = rpc.createMessageConnection(reader, writer);

		// Listen for notifications (diagnostics etc.)
		this.connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
			// Replace previous notification for same URI (keep only latest)
			const idx = this._notifications.findIndex((n) => n.uri === params.uri);
			if (idx !== -1) {
				this._notifications.splice(idx, 1);
			}
			this._notifications.push(params);
		});

		this.connection.listen();
		this._running = true;
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		if (!this.connection) {
			throw new Error("LSP client not started");
		}

		// Double-initialize guard: if already initialized, return immediately.
		// If another init is in-flight, await its promise.
		if (this._initialized) return;
		if (this._initPromise) return this._initPromise;

		this._initPromise = this._doInitialize(signal);
		try {
			await this._initPromise;
		} finally {
			this._initPromise = null;
		}
	}

	private async _doInitialize(signal?: AbortSignal): Promise<void> {
		// Check for cancellation before the expensive JSON-RPC round-trip
		if (signal?.aborted) throw new Error("LSP initialization cancelled");

		const initParams: InitializeParams = {
			processId: process.pid,
			rootUri: pathToUri(this.workspaceRoot),
			capabilities: {
				textDocument: {
					publishDiagnostics: {},
					synchronization: {},
					definition: {},
					references: {},
					hover: {},
					codeAction: {},
					signatureHelp: {},
					implementation: {},
					codeLens: {},
					documentSymbol: {
						hierarchicalDocumentSymbolSupport: true,
					},
					foldingRange: {},
					semanticTokens: {
						requests: { full: true },
						tokenTypes: [
							"namespace",
							"type",
							"class",
							"enum",
							"interface",
							"struct",
							"typeParameter",
							"parameter",
							"variable",
							"property",
							"enumMember",
							"event",
							"function",
							"method",
							"macro",
							"keyword",
							"modifier",
							"comment",
							"string",
							"number",
							"regexp",
							"operator",
						],
						tokenModifiers: [
							"declaration",
							"definition",
							"readonly",
							"static",
							"deprecated",
							"abstract",
							"async",
							"modification",
							"documentation",
							"defaultLibrary",
						],
						formats: ["relative"],
					},
				},
				workspace: {
					symbol: {},
				},
			},
			workspaceFolders: null,
		};

		const result = await this._sendRequest<InitializeResult>("initialize", initParams, 10000);

		this._serverCapabilities = ((result as InitializeResult).capabilities as Record<string, unknown>) ?? {};

		await this.connection!.sendNotification("initialized", {});
		this._initialized = true;
		this._log(`LSP initialized: ${this.command[0]}`);
	}

	async didOpen(filePath: string, text: string): Promise<void> {
		if (!this.connection) {
			throw new Error("LSP client not started");
		}

		// Skip large files
		const byteLength = Buffer.byteLength(text, "utf-8");
		if (byteLength > MAX_LSP_FILE_SIZE) {
			this._log(`Skipping LSP for large file ${filePath} (${byteLength} bytes)`);
			return;
		}

		const resolvedPath = this.resolveRel(filePath);
		if (this._openedFiles.has(resolvedPath) || this._openingFiles.has(resolvedPath)) {
			return;
		}
		this._openingFiles.add(resolvedPath);

		const uri = pathToUri(filePath);

		const params: DidOpenTextDocumentParams = {
			textDocument: {
				uri,
				languageId: lspLanguageId(this._detectLanguage(filePath), filePath),
				version: 1,
				text,
			},
		};

		try {
			await this.connection.sendNotification("textDocument/didOpen", params);
			this._openedFiles.add(resolvedPath);
			this._docVersions.set(uri, 1);
		} finally {
			this._openingFiles.delete(resolvedPath);
		}
	}

	private _docVersions = new Map<string, number>();

	/**
	 * Resolve a file path relative to workspaceRoot. Returns filePath
	 * unchanged if it is already absolute.
	 */
	private resolveRel(filePath: string): string {
		if (path.isAbsolute(filePath)) return filePath;
		return path.resolve(this.workspaceRoot, filePath);
	}

	async didChange(filePath: string, text: string): Promise<void> {
		if (!this.connection) {
			this._log("didChange: connection not available");
			return;
		}

		if (!this.isFileOpened(filePath)) return;

		// Skip large files
		const byteLength = Buffer.byteLength(text, "utf-8");
		if (byteLength > MAX_LSP_FILE_SIZE) {
			this._log(`Skipping LSP didChange for large file ${filePath} (${byteLength} bytes)`);
			return;
		}

		const uri = pathToUri(filePath);
		const nextVersion = (this._docVersions.get(uri) ?? 0) + 1;
		this._docVersions.set(uri, nextVersion);

		const params: DidChangeTextDocumentParams = {
			textDocument: {
				uri,
				version: nextVersion,
			},
			contentChanges: [
				{
					text,
				},
			],
		};

		await this.connection.sendNotification("textDocument/didChange", params);
	}

	async didClose(filePath: string): Promise<void> {
		const uri = pathToUri(filePath);
		this._docVersions.delete(uri);
		this._openedFiles.delete(this.resolveRel(filePath));
	}

	async didSave(filePath: string): Promise<void> {
		if (!this.connection) {
			this._log("didSave: connection not available");
			return;
		}

		if (!this.isFileOpened(filePath)) return;

		const uri = pathToUri(filePath);

		const params: DidSaveTextDocumentParams = {
			textDocument: {
				uri,
			},
		};

		await this.connection.sendNotification("textDocument/didSave", params);
	}

	async request(method: string, params: unknown): Promise<unknown> {
		if (!this.connection) {
			throw new Error("LSP client not started");
		}

		return this._sendRequest(method, params);
	}

	// ── Protocol methods ───────────────────────────────────────────────────────

	async definition(filePath: string, line: number, character: number): Promise<LspResult<Location | Location[]>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).definitionProvider) {
			return { status: "error", reason: "definition provider not supported", timeout: false };
		}

		const params: DefinitionParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
		};

		try {
			const result = await this._sendRequest<Location | Location[] | null>("textDocument/definition", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] definition failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async references(filePath: string, line: number, character: number): Promise<LspResult<Location[]>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).referencesProvider) {
			return { status: "error", reason: "references provider not supported", timeout: false };
		}

		const params: ReferenceParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
			context: { includeDeclaration: true },
		};

		try {
			const result = await this._sendRequest<Location[] | null>("textDocument/references", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] references failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async hover(filePath: string, line: number, character: number): Promise<LspResult<Hover>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).hoverProvider) {
			return { status: "error", reason: "hover provider not supported", timeout: false };
		}

		const params: HoverParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
		};

		try {
			const result = await this._sendRequest<Hover | null>("textDocument/hover", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] hover failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async documentSymbols(filePath: string): Promise<LspResult<DocumentSymbol[] | SymbolInformation[]>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).documentSymbolProvider) {
			return { status: "error", reason: "documentSymbol provider not supported", timeout: false };
		}

		const params: DocumentSymbolParams = {
			textDocument: { uri: pathToUri(filePath) },
		};

		try {
			const result = await this._sendRequest<DocumentSymbol[] | SymbolInformation[] | null>(
				"textDocument/documentSymbol",
				params,
			);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] documentSymbols failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async workspaceSymbol(query: string): Promise<LspResult<SymbolInformation[] | WorkspaceSymbol[]>> {
		if (!this.connection) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).workspaceSymbolProvider) {
			return { status: "error", reason: "workspaceSymbol provider not supported", timeout: false };
		}

		const params: WorkspaceSymbolParams = { query };

		try {
			const result = await this._sendRequest<SymbolInformation[] | WorkspaceSymbol[] | null>(
				"workspace/symbol",
				params,
			);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] workspaceSymbol failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async semanticTokens(filePath: string): Promise<LspResult<SemanticTokens>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		const stProvider = (cap as Record<string, unknown> | undefined)?.semanticTokensProvider;
		if (!stProvider) {
			return { status: "error", reason: "semanticTokens provider not supported", timeout: false };
		}

		const params: SemanticTokensParams = {
			textDocument: { uri: pathToUri(filePath) },
		};

		try {
			const result = await this._sendRequest<SemanticTokens | null>("textDocument/semanticTokens/full", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] semanticTokens failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async foldingRange(filePath: string): Promise<LspResult<FoldingRange[]>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).foldingRangeProvider) {
			return { status: "error", reason: "foldingRange provider not supported", timeout: false };
		}

		const params: FoldingRangeParams = {
			textDocument: { uri: pathToUri(filePath) },
		};

		try {
			const result = await this._sendRequest<FoldingRange[] | null>("textDocument/foldingRange", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] foldingRange failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	/**
	 * Request a cross-file rename via LSP textDocument/rename.
	 * Returns a WorkspaceEdit describing all changes, or null on failure.
	 */
	async rename(filePath: string, line: number, character: number, newName: string): Promise<LspResult<WorkspaceEdit>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };

		const params = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
			newName,
		};

		try {
			const result = await this._sendRequest<WorkspaceEdit | null>("textDocument/rename", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] rename failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async codeAction(
		filePath: string,
		startLine: number,
		startChar: number,
		endLine: number,
		endChar: number,
	): Promise<LspResult<(CodeAction | import("vscode-languageserver-protocol").Command)[]>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).codeActionProvider) {
			return { status: "error", reason: "codeAction provider not supported", timeout: false };
		}

		const params: CodeActionParams = {
			textDocument: { uri: pathToUri(filePath) },
			range: {
				start: { line: startLine, character: startChar },
				end: { line: endLine, character: endChar },
			},
			context: { diagnostics: [] },
		};

		try {
			const result = await this._sendRequest<(CodeAction | import("vscode-languageserver-protocol").Command)[] | null>(
				"textDocument/codeAction",
				params,
			);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] codeAction failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async signatureHelp(filePath: string, line: number, character: number): Promise<LspResult<SignatureHelp>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).signatureHelpProvider) {
			return { status: "error", reason: "signatureHelp provider not supported", timeout: false };
		}

		const params: SignatureHelpParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
		};

		try {
			const result = await this._sendRequest<SignatureHelp | null>("textDocument/signatureHelp", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] signatureHelp failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async implementation(filePath: string, line: number, character: number): Promise<LspResult<Location | Location[]>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).implementationProvider) {
			return { status: "error", reason: "implementation provider not supported", timeout: false };
		}

		const params: ImplementationParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
		};

		try {
			const result = await this._sendRequest<Location | Location[] | null>("textDocument/implementation", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] implementation failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	async codeLens(filePath: string): Promise<LspResult<CodeLens[]>> {
		if (!this.isFileOpened(filePath)) return { status: "ok", data: null };
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).codeLensProvider) {
			return { status: "error", reason: "codeLens provider not supported", timeout: false };
		}

		const params: CodeLensParams = {
			textDocument: { uri: pathToUri(filePath) },
		};

		try {
			const result = await this._sendRequest<CodeLens[] | null>("textDocument/codeLens", params);
			return { status: "ok", data: result ?? null };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isTimeout = msg.includes("timed out");
			this._log(`[lsp] codeLens failed: ${msg}`);
			return { status: "error", reason: msg, timeout: isTimeout };
		}
	}

	/**
	 * Race a request against a per-request timeout.
	 * Uses this.timeout (default 8000ms) when no custom timeout is provided.
	 * Returns null (via rejection caught by caller) when timeout fires first.
	 * When onCancel is provided, it is called on timeout to cancel the
	 * underlying request (e.g., CancellationTokenSource.cancel()).
	 */
	private withTimeout<T>(promise: Promise<T>, timeoutMs?: number, onCancel?: () => void): Promise<T> {
		const ms = timeoutMs ?? this.timeout;
		return new Promise<T>((resolve, reject) => {
			this._inFlightRequests.set(promise, reject);

			const timer = setTimeout(() => {
				this._inFlightRequests.delete(promise);
				void promise.catch(() => {});
				// Cancel the underlying LSP request to free server resources
				if (onCancel) {
					try {
						onCancel();
					} catch {
						// ignore cancel errors
					}
				}
				reject(new Error(`LSP request timed out after ${ms}ms`));
			}, ms);
			promise
				.then((v) => {
					this._inFlightRequests.delete(promise);
					clearTimeout(timer);
					resolve(v);
				})
				.catch((err) => {
					this._inFlightRequests.delete(promise);
					clearTimeout(timer);
					reject(err);
				});
		});
	}

	/**
	 * Send an LSP request with automatic cancellation on timeout.
	 * Creates a CancellationTokenSource, passes the token to sendRequest,
	 * and cancels it if the timeout fires — so the server can stop work.
	 */
	private _sendRequest<R>(method: string, params: unknown, timeoutMs?: number): Promise<R> {
		if (!this.connection) {
			return Promise.reject(new Error("LSP connection not available"));
		}
		const cts = new rpc.CancellationTokenSource();
		const promise = this.connection.sendRequest<R>(method, params, cts.token);
		return this.withTimeout(promise, timeoutMs, () => cts.cancel()).finally(() => cts.dispose());
	}

	/**
	 * Cancel all in-flight LSP requests. Safe to call after close().
	 */
	cancelInflight(): void {
		const err = new Error("LSP request cancelled");
		for (const [p, reject] of this._inFlightRequests) {
			void p.catch(() => {});
			reject(err);
		}
		this._inFlightRequests.clear();
	}

	// ── Diagnostics ────────────────────────────────────────────────────────────

	/**
	 * Collect diagnostics for a set of file paths.
	 * Returns the newest notification per URI (iterates in reverse).
	 */
	collectDiagnostics(filePaths: string[]): PublishDiagnosticsParams[] {
		const expectedUris = new Set(
			filePaths.filter((f) => this.isFileOpened(f)).map((f) => pathToUri(this.resolveRel(f))),
		);

		if (expectedUris.size === 0) return [];

		const results: PublishDiagnosticsParams[] = [];
		const remaining: PublishDiagnosticsParams[] = [];

		// Iterate in reverse to return the newest notification per URI first
		for (let i = this._notifications.length - 1; i >= 0; i--) {
			const notif = this._notifications[i]!;
			if (expectedUris.has(notif.uri)) {
				results.push(notif);
				expectedUris.delete(notif.uri);
			} else {
				remaining.push(notif);
			}
		}
		this._notifications = remaining;

		return results;
	}

	// ── Crash cleanup ────────────────────────────────────────────────────────────

	/**
	 * Clean up after an unexpected process crash or error.
	 * Disposes the connection and rejects all in-flight requests.
	 */
	private _cleanupAfterCrash(): void {
		// During intentional close(), the finally block handles cleanup.
		// Suppress double-cleanup from the exit handler firing after kill().
		if (this._closing) return;

		const closeError = new Error("LSP process exited unexpectedly");

		// Reject all in-flight requests
		for (const [p, reject] of this._inFlightRequests) {
			void p.catch(() => {});
			reject(closeError);
		}
		this._inFlightRequests.clear();

		// Dispose connection
		if (this.connection) {
			try {
				this.connection.dispose();
			} catch {
				// ignore dispose errors on crash
			}
		}

		this._running = false;
		this.connection = null;
		this.process = null;
		this._openedFiles.clear();
		this._notifications = [];
		this._serverCapabilities = {};
		this._initialized = false;
	}

	// ── Close ──────────────────────────────────────────────────────────────────

	async close(): Promise<void> {
		// Concurrent-close guard: if already closing, return existing promise.
		if (this._closePromise) return this._closePromise;

		if (!this.process) return;

		this._closePromise = this._doClose();
		return this._closePromise;
	}

	private async _doClose(): Promise<void> {
		this._log(`Closing LSP: ${this.command[0]}`);

		const proc = this.process;
		const closeError = new Error("connection closed");

		// Set flag to suppress _cleanupAfterCrash during intentional close
		this._closing = true;

		try {
			// 1. Clean shutdown handshake: await shutdown, then exit, then dispose.
			if (this.connection) {
				try {
					await this.withTimeout(this.connection.sendRequest("shutdown"), 5000);
				} catch (err) {
					this._log(`LSP close: shutdown request failed: ${err}`);
				}
				try {
					await this.connection.sendNotification("exit");
				} catch (err) {
					this._log(`LSP close: exit notification failed: ${err}`);
				}
				try {
					this.connection.dispose();
				} catch (err) {
					this._log(`LSP close: dispose failed: ${err}`);
				}
			}

			// 2. Remove our event listeners before kill to prevent crash handler
			//    from firing during intentional close.
			if (proc) {
				proc.removeAllListeners("exit");
				proc.removeAllListeners("error");
				try {
					if (proc.stderr) {
						proc.stderr.removeAllListeners("data");
					}
				} catch {
					// stderr may not be an EventEmitter (e.g., in tests).
				}
			}

			// 3. Kill the process if it hasn't exited after the shutdown handshake.
			if (proc && proc.exitCode === null) {
				proc.kill();
			}

			// 4. Wait for process exit with fallback SIGKILL if it refuses to exit.
			if (proc && proc.exitCode === null) {
				await new Promise<void>((resolve) => {
					const fallbackTimer = setTimeout(() => {
						try {
							proc.kill("SIGKILL");
						} catch {
							/* ignore */
						}
						resolve();
					}, 2000);
					proc.once("exit", () => {
						clearTimeout(fallbackTimer);
						resolve();
					});
				});
			}
		} finally {
			// 5. Cancel all in-flight LSP requests to prevent unhandled rejections.
			for (const [p, reject] of this._inFlightRequests) {
				void p.catch(() => {});
				reject(closeError);
			}
			this._inFlightRequests.clear();

			this._running = false;
			this.connection = null;
			this.process = null;
			this._openedFiles.clear();
			this._notifications = [];
			this._serverCapabilities = {};
			this._closing = false;
		}
	}

	// ── Internal ───────────────────────────────────────────────────────────────

	private _detectLanguage(filePath: string): string {
		// Extension-based detection for LSP didOpen.
		//
		// DESIGN DECISION: Intentionally scoped to 7 languages with well-tested
		// LSP server coverage. Do NOT extend this list without:
		//   1. Verifying a working LSP server exists for the language
		//   2. Testing didOpen/didChange/diagnostics round-trip
		//   3. Updating the Language Support section in mcp/README.md
		//
		// Remaining languages in EXT_TO_LANG (C/C++, Java, C#, Ruby, HTML, CSS)
		// use tree-sitter parsing only. This is by design — see issue #94.
		const ext = path.extname(filePath).toLowerCase();
		const map: Record<string, string> = {
			".py": "python",
			".pyi": "python",
			".pyx": "python",
			".pxd": "python",
			".ts": "typescript",
			".tsx": "typescriptreact",
			".mts": "typescript",
			".cts": "typescript",
			".js": "javascript",
			".jsx": "javascriptreact",
			".mjs": "javascript",
			".cjs": "javascript",
			".go": "go",
			".rs": "rust",
			".json": "json",
			".jsonc": "jsonc",
			".json5": "json5",
			".yaml": "yaml",
			".yml": "yaml",
		};
		return map[ext] ?? "plaintext";
	}
}

// ── Diagnostic conversion helpers ────────────────────────────────────────────

export interface RawLspDiagnostic {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	severity?: number;
	code?: string | number;
	message: string;
	source?: string;
}

export function convertDiagnostics(
	projectRoot: string,
	uri: string,
	rawDiagnostics: RawLspDiagnostic[],
): LspDiagnostic[] {
	const filePath = uriToPath(uri);
	const relFile = path.relative(projectRoot, filePath) || filePath;

	return rawDiagnostics.map((d) => ({
		file: relFile,
		line: d.range.start.line + 1, // LSP 0-based → 1-based
		col: d.range.start.character + 1,
		endLine: d.range.end.line + 1,
		endCol: d.range.end.character + 1,
		severity: severityName(d.severity),
		code: String(d.code ?? ""),
		message: d.message,
		source: d.source ?? "lsp",
	}));
}

export function convertLocation(projectRoot: string, loc: Location): LspLocation {
	const filePath = uriToPath(loc.uri);
	const relFile = path.relative(projectRoot, filePath) || filePath;

	return {
		file: relFile,
		line: loc.range.start.line + 1,
		col: loc.range.start.character + 1,
		endLine: loc.range.end.line + 1,
		endCol: loc.range.end.character + 1,
	};
}

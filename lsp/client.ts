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
} = _require("vscode-jsonrpc/node");

import type {
	InitializeParams,
	InitializeResult,
	DidOpenTextDocumentParams,
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
} from "vscode-languageserver-protocol";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_LSP_FILE_SIZE = 1_048_576; // 1 MiB

// ── Types ────────────────────────────────────────────────────────────────────

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
	// file:// URI with absolute path
	const normalized = resolved.replace(/\\/g, "/");
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
	private _serverCapabilities: Record<string, unknown> = {};
	private _running = false;
	private _log: (msg: string) => void;

	// Store notifications (e.g., diagnostics) received outside request-response
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

	isFileOpened(filePath: string): boolean {
		return this._openedFiles.has(path.resolve(filePath));
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
			this._running = false;
			this.connection = null;
			this._openedFiles.clear();
			this._notifications = [];
			this._serverCapabilities = {};
		});

		this.process.on("exit", (code, signal) => {
			this._log(`LSP process exited: code=${code}, signal=${signal}`);
			this._running = false;
			this.connection = null;
			this._openedFiles.clear();
			this._notifications = [];
			this._serverCapabilities = {};
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
			this._notifications.push(params);
		});

		this.connection.listen();
		this._running = true;
	}

	async initialize(): Promise<void> {
		if (!this.connection) {
			throw new Error("LSP client not started");
		}

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

		const result = await this.connection.sendRequest<InitializeResult>("initialize", initParams);

		this._serverCapabilities = ((result as InitializeResult).capabilities as Record<string, unknown>) ?? {};

		await this.connection.sendNotification("initialized", {});
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

		const uri = pathToUri(filePath);

		const params: DidOpenTextDocumentParams = {
			textDocument: {
				uri,
				languageId: lspLanguageId(this._detectLanguage(filePath), filePath),
				version: 1,
				text,
			},
		};

		await this.connection.sendNotification("textDocument/didOpen", params);
		this._openedFiles.add(path.resolve(filePath));
	}

	async request(method: string, params: unknown): Promise<unknown> {
		if (!this.connection) {
			throw new Error("LSP client not started");
		}

		return this.connection.sendRequest(method, params);
	}

	// ── Protocol methods ───────────────────────────────────────────────────────

	async definition(filePath: string, line: number, character: number): Promise<Location | Location[] | null> {
		if (!this.isFileOpened(filePath)) return null;

		const params: DefinitionParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
		};

		try {
			const result = await this.withTimeout(
				this.connection!.sendRequest<Location | Location[] | null>("textDocument/definition", params),
			);
			return result ?? null;
		} catch (err) {
			console.warn("[lsp] definition failed:", err);
			return null;
		}
	}

	async references(filePath: string, line: number, character: number): Promise<Location[] | null> {
		if (!this.isFileOpened(filePath)) return null;

		const params: ReferenceParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
			context: { includeDeclaration: true },
		};

		try {
			const result = await this.withTimeout(
				this.connection!.sendRequest<Location[] | null>("textDocument/references", params),
			);
			return result ?? null;
		} catch (err) {
			console.warn("[lsp] references failed:", err);
			return null;
		}
	}

	async hover(filePath: string, line: number, character: number): Promise<Hover | null> {
		if (!this.isFileOpened(filePath)) return null;

		const params: HoverParams = {
			textDocument: { uri: pathToUri(filePath) },
			position: { line, character },
		};

		try {
			const result = await this.withTimeout(this.connection!.sendRequest<Hover | null>("textDocument/hover", params));
			return result ?? null;
		} catch (err) {
			console.warn("[lsp] hover failed:", err);
			return null;
		}
	}

	async documentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
		if (!this.isFileOpened(filePath)) return null;

		const params: DocumentSymbolParams = {
			textDocument: { uri: pathToUri(filePath) },
		};

		try {
			const result = await this.withTimeout(
				this.connection!.sendRequest<DocumentSymbol[] | SymbolInformation[] | null>(
					"textDocument/documentSymbol",
					params,
				),
			);
			return result ?? null;
		} catch (err) {
			console.warn("[lsp] documentSymbols failed:", err);
			return null;
		}
	}

	async workspaceSymbol(query: string): Promise<SymbolInformation[] | WorkspaceSymbol[] | null> {
		if (!this.connection) return null;
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).workspaceSymbolProvider) {
			return null;
		}

		const params: WorkspaceSymbolParams = { query };

		try {
			const result = await this.withTimeout(
				this.connection.sendRequest<SymbolInformation[] | WorkspaceSymbol[] | null>("workspace/symbol", params),
			);
			return result ?? null;
		} catch (err) {
			console.warn("[lsp] workspaceSymbol failed:", err);
			return null;
		}
	}

	async semanticTokens(filePath: string): Promise<SemanticTokens | null> {
		if (!this.isFileOpened(filePath)) return null;
		const cap = this._serverCapabilities;
		const stProvider = (cap as Record<string, unknown> | undefined)?.semanticTokensProvider;
		if (!stProvider) return null;

		const params: SemanticTokensParams = {
			textDocument: { uri: pathToUri(filePath) },
		};

		try {
			const result = await this.withTimeout(
				this.connection!.sendRequest<SemanticTokens | null>("textDocument/semanticTokens/full", params),
			);
			return result ?? null;
		} catch (err) {
			console.warn("[lsp] semanticTokens failed:", err);
			return null;
		}
	}

	async foldingRange(filePath: string): Promise<FoldingRange[] | null> {
		if (!this.isFileOpened(filePath)) return null;
		const cap = this._serverCapabilities;
		if (!cap || !(cap as Record<string, unknown>).foldingRangeProvider) {
			return null;
		}

		const params: FoldingRangeParams = {
			textDocument: { uri: pathToUri(filePath) },
		};

		try {
			const result = await this.withTimeout(
				this.connection!.sendRequest<FoldingRange[] | null>("textDocument/foldingRange", params),
			);
			return result ?? null;
		} catch (err) {
			console.warn("[lsp] foldingRange failed:", err);
			return null;
		}
	}

	/**
	 * Race a request against the configured per-request timeout.
	 * Returns null (via rejection caught by caller) when timeout fires first.
	 */
	private withTimeout<T>(promise: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this._inFlightRequests.set(promise, reject);

			const timer = setTimeout(() => {
				this._inFlightRequests.delete(promise);
				void promise.catch(() => {});
				reject(new Error(`LSP request timed out after ${this.timeout}ms`));
			}, this.timeout);
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

	// ── Diagnostics ────────────────────────────────────────────────────────────

	/**
	 * Collect diagnostics for a set of file paths.
	 * Checks accumulated notifications first, then polls briefly for more.
	 */
	collectDiagnostics(filePaths: string[]): PublishDiagnosticsParams[] {
		const expectedUris = new Set(filePaths.filter((f) => this.isFileOpened(f)).map((f) => pathToUri(f)));

		if (expectedUris.size === 0) return [];

		const results: PublishDiagnosticsParams[] = [];
		const remaining: PublishDiagnosticsParams[] = [];

		for (const notif of this._notifications) {
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

	// ── Close ──────────────────────────────────────────────────────────────────

	async close(): Promise<void> {
		if (!this.process) return;

		this._log(`Closing LSP: ${this.command[0]}`);

		// Capture process reference before nulling — the 2s kill timeout
		// needs it after this.process is set to null below.
		const proc = this.process;

		// 1. Clean shutdown handshake: await shutdown, then exit, then dispose.
		if (this.connection) {
			try {
				await this.connection.sendRequest("shutdown");
			} catch (err) {
				this._log(`LSP close: shutdown request failed: ${err}`);
			}
			try {
				await this.connection.sendNotification("exit");
			} catch (err) {
				this._log(`LSP close: exit notification failed: ${err}`);
			}
			this.connection.dispose();
		}

		// 2. Remove only our event listeners (not Node.js internal ones).
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

		// 4. Cancel all in-flight LSP requests to prevent unhandled rejections.
		const closeError = new Error("connection closed");
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
	}

	// ── Internal ───────────────────────────────────────────────────────────────

	private _detectLanguage(filePath: string): string {
		// Simple extension-based detection for didOpen
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

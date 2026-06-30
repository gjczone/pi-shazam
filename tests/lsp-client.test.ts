import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// ── Mock connections ───────────────────────────────────────────────────────────

interface MockConnection {
	sendRequest: ReturnType<typeof vi.fn>;
	sendNotification: ReturnType<typeof vi.fn>;
	onNotification: ReturnType<typeof vi.fn>;
	listen: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}

function createMockConnection(): MockConnection {
	return {
		sendRequest: vi.fn(),
		sendNotification: vi.fn(),
		onNotification: vi.fn(),
		listen: vi.fn(),
		dispose: vi.fn(),
	};
}

// ── Mock process ───────────────────────────────────────────────────────────────

class MockProcess extends EventEmitter {
	exitCode: number | null = null;
	killed = false;
	pid = 12345;
	stdin = { on: vi.fn(), write: vi.fn() };
	stdout = { on: vi.fn() };
	stderr = { on: vi.fn() };

	kill(signal?: string): boolean {
		this.killed = true;
		this.exitCode = this.exitCode ?? 1;
		this.emit("exit", this.exitCode, signal);
		return true;
	}
}

// ── Mock dynamic require for vscode-jsonrpc/node ──────────────────────────────

// client.ts uses createRequire() + _require(), not ESM import.
// vi.mock() only intercepts ESM imports, so we mock createRequire itself.
let mockConnForStart: MockConnection | null = null;

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	return {
		...actual,
		createRequire: vi.fn(() => (moduleName: string) => {
			if (moduleName === "vscode-jsonrpc/node") {
				return {
					StreamMessageReader: vi.fn(),
					StreamMessageWriter: vi.fn(),
					createMessageConnection: vi.fn(() => {
						// Return the mock connection prepared for start()
						return mockConnForStart ?? createMockConnection();
					}),
					CancellationTokenSource: class {
						token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
						cancel() {
							this.token.isCancellationRequested = true;
						}
						dispose() {}
					},
				};
			}
			// For any other dynamic require, use the real createRequire
			return actual.createRequire(import.meta.url)(moduleName);
		}),
	};
});

// Mock child_process spawn
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { LspClient } from "../lsp/client.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Create a client with internal state set directly (bypasses start()).
 * Used for testing close() logic without needing a real LSP handshake.
 */
function createRunningClient(opts?: { process?: MockProcess; connection?: MockConnection }): {
	client: LspClient;
	process: MockProcess;
	conn: MockConnection;
} {
	const proc = opts?.process ?? new MockProcess();
	const conn = opts?.connection ?? createMockConnection();

	const client = new LspClient(["mock-server", "--stdio"], "/test/workspace", 5000);

	(client as any).process = proc;
	(client as any).connection = conn;
	(client as any)._running = true;

	return { client, process: proc, conn };
}

/**
 * Create a client via start() (registers real event handlers on process).
 * Requires mocked child_process spawn and vscode-jsonrpc.
 */
function createStartedClient(conn?: MockConnection): {
	client: LspClient;
	process: MockProcess;
	conn: MockConnection;
} {
	const proc = new MockProcess();
	const spawnMock = spawn as any as ReturnType<typeof vi.fn>;
	spawnMock.mockReturnValue(proc);

	const c = conn ?? createMockConnection();
	mockConnForStart = c;

	const client = new LspClient(["mock-server", "--stdio"], "/test/workspace", 5000);
	client.start();

	return { client, process: proc, conn: c };
}

// ── Original tests ─────────────────────────────────────────────────────────────

describe("lsp/client", () => {
	describe("LspClient constructor", () => {
		it("should create an LspClient instance", () => {
			const client = new LspClient(["mock-server", "--stdio"], "/test/workspace", 5000);
			expect(client).toBeDefined();
			expect(client.command).toEqual(["mock-server", "--stdio"]);
			expect(client.workspaceRoot).toBe("/test/workspace");
			expect(client.timeout).toBe(5000);
		});

		it("should initialize with not-running state", () => {
			const client = new LspClient(["mock"], "/ws", 5000);
			expect(client.isRunning()).toBe(false);
		});
	});

	describe("LspClient lifecycle", () => {
		let client: LspClient;

		beforeEach(() => {
			client = new LspClient(["mock"], "/ws", 5000);
		});

		it("should track running state", () => {
			expect(client.isRunning()).toBe(false);
		});

		it("should have a close method", () => {
			expect(typeof client.close).toBe("function");
		});

		it("should have an initialize method", () => {
			expect(typeof client.initialize).toBe("function");
		});

		it("should expose isInitialized method", () => {
			expect(typeof client.isInitialized).toBe("function");
		});

		it("should start with isInitialized false", () => {
			expect(client.isInitialized()).toBe(false);
		});

		it("isInitialized should be false when client not started", () => {
			const result = client.isInitialized();
			expect(result).toBe(false);
		});
	});

	describe("LspClient protocol methods", () => {
		let client: LspClient;

		beforeEach(() => {
			client = new LspClient(["mock"], "/ws", 5000);
		});

		it("should expose didOpen method", () => {
			expect(typeof client.didOpen).toBe("function");
		});

		it("should expose didChange method", () => {
			expect(typeof client.didChange).toBe("function");
		});

		it("should expose didSave method", () => {
			expect(typeof client.didSave).toBe("function");
		});

		it("should expose request method", () => {
			expect(typeof client.request).toBe("function");
		});

		it("should expose close method", () => {
			expect(typeof client.close).toBe("function");
		});
	});

	describe("LspClient didChange", () => {
		it("should return undefined when client not started", async () => {
			const client = new LspClient(["mock"], "/ws", 5000);
			const result = await client.didChange("/test/file.ts", "new content");
			expect(result).toBeUndefined();
		});

		it("should skip large files", async () => {
			const { client, conn } = createRunningClient();

			// Create content larger than MAX_LSP_FILE_SIZE
			const largeContent = "x".repeat(5 * 1024 * 1024 + 1);
			const result = await client.didChange("/test/file.ts", largeContent);
			// Should not throw and should not send notification
			expect(result).toBeUndefined();
			expect(conn.sendNotification).not.toHaveBeenCalledWith("textDocument/didChange", expect.anything());
		});

		it("should send didChange notification with full content sync", async () => {
			const { client, conn } = createRunningClient();

			// First open the file
			const content = "const x = 1;";
			const newContent = "const x = 2;";

			// Manually add to opened files since we bypassed didOpen
			(client as any)._openedFiles.add("/test/file.ts");

			const result = await client.didChange("/test/file.ts", newContent);
			expect(result).toBeUndefined();

			// Verify didChange notification was sent
			const calls = conn.sendNotification.mock.calls.filter((c: any[]) => c[0] === "textDocument/didChange");
			expect(calls.length).toBe(1);

			const params = calls[0][1];
			expect(params.textDocument.uri).toContain("file.ts");
			expect(params.contentChanges).toBeDefined();
			expect(params.contentChanges.length).toBe(1);
			expect(params.contentChanges[0].text).toBe(newContent);
		});
	});

	describe("LspClient didSave", () => {
		it("should return undefined when client not started", async () => {
			const client = new LspClient(["mock"], "/ws", 5000);
			const result = await client.didSave("/test/file.ts");
			expect(result).toBeUndefined();
		});

		it("should send didSave notification", async () => {
			const { client, conn } = createRunningClient();

			// Manually add to opened files
			(client as any)._openedFiles.add("/test/file.ts");

			const result = await client.didSave("/test/file.ts");
			expect(result).toBeUndefined();

			const calls = conn.sendNotification.mock.calls.filter((c: any[]) => c[0] === "textDocument/didSave");
			expect(calls.length).toBe(1);

			const params = calls[0][1];
			expect(params.textDocument.uri).toContain("file.ts");
		});
	});

	describe("LspClient opened files tracking", () => {
		it("should track opened files", () => {
			const client = new LspClient(["mock"], "/ws", 5000);
			expect(client.isFileOpened("/test/file.ts")).toBe(false);
		});
	});
});

// ── close() tests ──────────────────────────────────────────────────────────────

describe("LspClient initialize()", () => {
	beforeEach(() => {
		mockConnForStart = null;
	});

	it("should return initialized state after successful init", async () => {
		const conn = createMockConnection();
		conn.sendRequest.mockResolvedValue({
			capabilities: { hoverProvider: true },
		});
		const { client } = createStartedClient(conn);

		await client.initialize();
		expect(client.isInitialized()).toBe(true);
	});

	it("should not send duplicate initialize when called twice", async () => {
		const conn = createMockConnection();
		conn.sendRequest.mockResolvedValue({
			capabilities: { hoverProvider: true },
		});
		const { client } = createStartedClient(conn);

		await Promise.all([client.initialize(), client.initialize()]);

		// Should only have sent one initialize request
		const initCalls = conn.sendRequest.mock.calls.filter((c: any[]) => c[0] === "initialize");
		expect(initCalls.length).toBe(1);
	});

	it("should await in-flight initialize on concurrent calls", async () => {
		const conn = createMockConnection();
		let resolveInit: (v: unknown) => void = () => {};
		conn.sendRequest.mockReturnValue(
			new Promise((resolve) => {
				resolveInit = resolve;
			}),
		);
		const { client } = createStartedClient(conn);

		// Start concurrent initializations
		const init1 = client.initialize();
		const init2 = client.initialize();

		// Resolve the first
		resolveInit({ capabilities: {} });

		await Promise.all([init1, init2]);

		// Should only have sent one initialize request
		const initCalls = conn.sendRequest.mock.calls.filter((c: any[]) => c[0] === "initialize");
		expect(initCalls.length).toBe(1);
	});
});

describe("LspClient close()", () => {
	// ═══ Bug 1: Zombie process — process reference nulled before timeout fires ═══
	describe("process cleanup", () => {
		it("should kill the process", async () => {
			const proc = new MockProcess();
			proc.exitCode = null;
			const conn = createMockConnection();
			conn.sendRequest.mockResolvedValue(null);
			const { client } = createRunningClient({ process: proc, connection: conn });

			const closeResult = client.close();
			expect(closeResult).toBeInstanceOf(Promise);
			await closeResult;

			expect(proc.killed).toBe(true);
		});

		it("should not throw if process already exited", async () => {
			const proc = new MockProcess();
			proc.exitCode = 0;
			const conn = createMockConnection();
			conn.sendRequest.mockResolvedValue(null);
			const { client } = createRunningClient({ process: proc, connection: conn });

			const closeResult = client.close();
			expect(closeResult).toBeInstanceOf(Promise);
			await closeResult;
		});
	});

	// ═══ Bug 2: Premature dispose — shutdown not awaited ═══
	describe("shutdown sequence", () => {
		it("should send shutdown before exit notification", async () => {
			const { client, conn } = createRunningClient();
			conn.sendRequest.mockResolvedValue(null);

			const closeResult = client.close();
			expect(closeResult).toBeInstanceOf(Promise);
			await closeResult;

			const shutdownCalls = conn.sendRequest.mock.calls.filter((c: any[]) => c[0] === "shutdown");
			const exitCalls = conn.sendNotification.mock.calls.filter((c: any[]) => c[0] === "exit");

			expect(shutdownCalls.length).toBeGreaterThanOrEqual(1);
			expect(exitCalls.length).toBeGreaterThanOrEqual(1);
		});

		it("should complete shutdown before dispose", async () => {
			const { client, conn } = createRunningClient();

			let shutdownCompleted = false;
			conn.sendRequest.mockImplementation(async (method: string) => {
				if (method === "shutdown") {
					await new Promise((r) => setTimeout(r, 10));
					shutdownCompleted = true;
					return null;
				}
				return null;
			});

			const closeResult = client.close();
			expect(closeResult).toBeInstanceOf(Promise);
			await closeResult;

			expect(shutdownCompleted).toBe(true);
			expect(conn.dispose).toHaveBeenCalled();
		});
	});

	// ═══ State cleanup ═══
	describe("state cleanup", () => {
		it("should set isRunning to false after close", async () => {
			const { client, conn } = createRunningClient();
			conn.sendRequest.mockResolvedValue(null);

			expect(client.isRunning()).toBe(true);

			const closeResult = client.close();
			expect(closeResult).toBeInstanceOf(Promise);
			await closeResult;

			expect(client.isRunning()).toBe(false);
		});
	});
});

// ═══ Exit handler cleanup ═══
describe("LspClient exit handler", () => {
	beforeEach(() => {
		mockConnForStart = null;
	});

	it("should set _running to false when process exits unexpectedly", () => {
		const conn = createMockConnection();
		const { client, process: proc } = createStartedClient(conn);

		expect(client.isRunning()).toBe(true);

		// Simulate unexpected process crash (exit handler registered by start())
		proc.exitCode = 1;
		proc.emit("exit", 1, "SIGTERM");

		expect(client.isRunning()).toBe(false);
	});
});

// ═══ withTimeout tests ═══
describe("LspClient withTimeout", () => {
	it("should track and cancel in-flight requests on timeout", async () => {
		const { client } = createStartedClient();

		const withTimeout = (client as any).withTimeout.bind(client) as <T>(p: Promise<T>) => Promise<T>;
		(client as any).timeout = 1;

		// Create a slow promise
		const slowPromise = new Promise<null>((resolve) => {
			setTimeout(() => resolve(null), 1000);
		});

		const result = withTimeout(slowPromise);
		await expect(result).rejects.toThrow("timed out");

		// After timeout, the in-flight set should be empty (promise was cleaned up)
		const inFlight = (client as any)._inFlightRequests as Set<Promise<unknown>> | undefined;
		if (inFlight) {
			expect(inFlight.size).toBe(0);
		}
	});

	it("should cancel in-flight requests when close() is called", async () => {
		const { client, conn } = createStartedClient();
		conn.sendRequest.mockResolvedValue(null);

		const withTimeout = (client as any).withTimeout.bind(client) as <T>(p: Promise<T>) => Promise<T>;
		(client as any).timeout = 60000;

		// Start a request that never resolves
		const neverResolves = new Promise<null>(() => {});
		const timeoutPromise = withTimeout(neverResolves);

		// Verify it's tracked as in-flight
		const inFlight = (client as any)._inFlightRequests as Map<Promise<unknown>, (err: Error) => void>;
		expect(inFlight).toBeDefined();
		expect(inFlight.size).toBe(1);

		// Close should cancel all in-flight
		const closePromise = client.close();

		// The timeout promise should reject (connection closed)
		await expect(timeoutPromise).rejects.toThrow("connection closed");

		await closePromise;
		expect(client.isRunning()).toBe(false);

		// In-flight set should be empty
		expect(inFlight.size).toBe(0);
	});
});

// ═══ Edge case tests (from #47) ═══
describe("LspClient edge cases", () => {
	beforeEach(() => {
		mockConnForStart = null;
	});

	it("should clear _notifications and _serverCapabilities after close", async () => {
		const { client, conn } = createRunningClient();
		conn.sendRequest.mockResolvedValue(null);

		// Pre-populate state
		(client as any)._notifications = new Map([["file:///test.ts", { uri: "file:///test.ts", diagnostics: [] }]]);
		(client as any)._serverCapabilities = { hoverProvider: true };

		const closeResult = client.close();
		expect(closeResult).toBeInstanceOf(Promise);
		await closeResult;

		expect((client as any)._notifications.size).toBe(0);
		expect((client as any)._serverCapabilities).toEqual({});
	});

	it("should be a no-op when close() is called twice", async () => {
		const { client, conn } = createRunningClient();
		conn.sendRequest.mockResolvedValue(null);

		await client.close();
		expect(client.isRunning()).toBe(false);

		// Second close: should not throw
		const closeResult2 = client.close();
		expect(closeResult2).toBeInstanceOf(Promise);
		await closeResult2;

		expect(client.isRunning()).toBe(false);
	});

	it("should be safe to call close() before start()", async () => {
		const client = new LspClient(["mock"], "/ws", 5000);

		// close() on unstarted client: guard should return immediately
		const closeResult = client.close();
		expect(closeResult).toBeInstanceOf(Promise);
		await closeResult;

		// No crash, client still not running
		expect(client.isRunning()).toBe(false);
	});

	it("should clean up if process crashes and then close() is called", async () => {
		// Simulate: process crashes, exit handler fires (_running=false),
		// but this.process still references the dead ChildProcess.
		const conn = createMockConnection();
		conn.sendRequest.mockResolvedValue(null);
		const { client, process: proc } = createStartedClient(conn);

		// Crash the process
		proc.exitCode = 1;
		proc.emit("exit", 1, "SIGTERM");

		expect(client.isRunning()).toBe(false);

		// close() should still clean up the stale process reference
		await client.close();
		expect(client.isRunning()).toBe(false);
	});

	describe("LspClient crash and close cleanup", () => {
		it("should reject in-flight requests when process crashes", async () => {
			let rejectInFlight: (err: Error) => void = () => {};
			const conn = createMockConnection();
			const { client, process: proc } = createStartedClient(conn);

			// Register an in-flight request
			const inFlightPromise = new Promise<unknown>((_resolve, reject) => {
				rejectInFlight = reject;
			});
			(client as any)._inFlightRequests.set(inFlightPromise, rejectInFlight);

			// Crash the process — exit handler should clean up
			proc.exitCode = 1;
			proc.emit("exit", 1, "SIGTERM");

			expect(client.isRunning()).toBe(false);
			// In-flight promises should be rejected
			await expect(inFlightPromise).rejects.toThrow();
		});

		it("should reject in-flight requests and dispose connection on crash", async () => {
			const conn = createMockConnection();
			const { client, process: proc } = createStartedClient(conn);

			// Register an in-flight request
			const neverResolves = new Promise<never>(() => {});
			(client as any)._inFlightRequests.set(neverResolves, (err: Error) => {});

			// Crash
			proc.exitCode = 1;
			proc.emit("exit", 1, "SIGTERM");

			// Should have disposed the connection
			expect(conn.dispose).toHaveBeenCalled();
			// _inFlightRequests should be empty (all rejected and removed)
			expect((client as any)._inFlightRequests.size).toBe(0);
		});

		it("should handle concurrent close() calls without double-dispose", async () => {
			const conn = createMockConnection();
			conn.sendRequest.mockResolvedValue(null);
			const { client, process: proc } = createStartedClient(conn);

			// Make process exit wait so we can call close() twice
			proc.exitCode = null;

			const close1 = client.close();
			const close2 = client.close();

			await Promise.all([close1, close2]);

			// dispose should only be called once
			expect(conn.dispose).toHaveBeenCalledTimes(1);
			expect(client.isRunning()).toBe(false);
		});
	});
});

// ═══ didClose + collectDiagnostics bug tests ═══

describe("LspClient didClose and collectDiagnostics", () => {
	it("should send textDocument/didClose notification when closing a file", async () => {
		const { client, conn } = createStartedClient();

		// Manually add a file to opened files (bypass didOpen)
		(client as any)._openedFiles.add("/test/file.ts");

		await client.didClose("/test/file.ts");

		// Bug: didClose never sends the notification — this assertion fails
		expect(conn.sendNotification).toHaveBeenCalledWith(
			"textDocument/didClose",
			expect.objectContaining({
				textDocument: expect.objectContaining({
					uri: expect.stringContaining("file.ts"),
				}),
			}),
		);
	});

	it("should preserve notification order after consume", () => {
		const { client } = createStartedClient();

		// Open three files
		(client as any)._openedFiles.add("/test/fileA.ts");
		(client as any)._openedFiles.add("/test/fileB.ts");
		(client as any)._openedFiles.add("/test/fileC.ts");

		// Push 3 mock notifications in order: A, B, C
		const notifA = { uri: "file:///test/fileA.ts", diagnostics: [] };
		const notifB = { uri: "file:///test/fileB.ts", diagnostics: [] };
		const notifC = { uri: "file:///test/fileC.ts", diagnostics: [] };
		(client as any)._notifications = new Map([
			["file:///test/fileA.ts", notifA],
			["file:///test/fileB.ts", notifB],
			["file:///test/fileC.ts", notifC],
		]);

		// Consume fileA — remaining should be [B, C] in original order
		client.collectDiagnostics(["/test/fileA.ts"]);

		const remaining = (client as any)._notifications as Map<string, typeof notifA>;
		// Map preserves insertion order; after consuming A, B and C remain
		expect(remaining.size).toBe(2);
		const remainingEntries = [...remaining.values()];
		expect(remainingEntries[0]).toBe(notifB);
		expect(remainingEntries[1]).toBe(notifC);
	});
});

// ═══ Issue #556: didClose must clean up local state even when sendNotification rejects ═══

describe("LspClient didClose cleanup on sendNotification failure (#556)", () => {
	const FILE_PATH = "/test/workspace/src/file.ts";
	const FILE_URI = "file:///test/workspace/src/file.ts";

	function setupOpenedClient(): { client: LspClient; conn: MockConnection } {
		const { client, conn } = createRunningClient();
		// Pre-populate local tracking as if didOpen had succeeded.
		(client as any)._openedFiles.add(FILE_PATH);
		(client as any)._docVersions.set(FILE_URI, 1);
		expect(client.isFileOpened(FILE_PATH)).toBe(true);
		return { client, conn };
	}

	it("clears _docVersions and _openedFiles even when sendNotification rejects", async () => {
		const { client, conn } = setupOpenedClient();
		conn.sendNotification.mockRejectedValueOnce(new Error("connection disposed"));

		// The rejection must propagate (per issue constraint: do not swallow).
		await expect(client.didClose(FILE_PATH)).rejects.toThrow("connection disposed");

		// Local tracking MUST be cleared regardless of the rejection.
		expect((client as any)._docVersions.has(FILE_URI)).toBe(false);
		expect((client as any)._openedFiles.has(FILE_PATH)).toBe(false);
		expect(client.isFileOpened(FILE_PATH)).toBe(false);
	});

	it("does not leave stale opened-file state that would short-circuit a subsequent didOpen", async () => {
		// This is the user-facing symptom of the bug: after a failed didClose,
		// isFileOpened still returns true, so a subsequent didOpen for the same
		// file returns early — but the server no longer has it open, so
		// diagnostics stop arriving.
		const { client, conn } = setupOpenedClient();
		conn.sendNotification.mockRejectedValueOnce(new Error("connection disposed"));

		await expect(client.didClose(FILE_PATH)).rejects.toThrow("connection disposed");

		// After the failed didClose, isFileOpened must be false so the next
		// didOpen does not short-circuit.
		expect(client.isFileOpened(FILE_PATH)).toBe(false);

		// Subsequent didOpen should actually send the notification (not skip).
		// Reset sendNotification to resolve for the second didOpen.
		conn.sendNotification.mockResolvedValueOnce(undefined);
		await client.didOpen(FILE_PATH, "const x = 1;");

		const didOpenCalls = conn.sendNotification.mock.calls.filter((c: any[]) => c[0] === "textDocument/didOpen");
		expect(didOpenCalls.length).toBe(1);
	});

	it("still clears local state when connection is null (no notification sent)", async () => {
		// Regression: when connection is null, didClose early-returns after
		// the if (this.connection) check. The deletes must still run.
		const { client } = setupOpenedClient();
		// Simulate no connection.
		(client as any).connection = null;

		await client.didClose(FILE_PATH);

		expect((client as any)._docVersions.has(FILE_URI)).toBe(false);
		expect((client as any)._openedFiles.has(FILE_PATH)).toBe(false);
		expect(client.isFileOpened(FILE_PATH)).toBe(false);
	});
});

// ═══ Static gate: didClose body uses try/finally (#556) ═══

describe("didClose source structure (#556)", () => {
	it("didClose wraps sendNotification in try/finally so deletes run on rejection", () => {
		const { readFileSync } = require("node:fs");
		const { join } = require("node:path");
		const src = readFileSync(join(import.meta.dirname, "..", "lsp", "client.ts"), "utf-8");

		// Locate `async didClose(...)` and walk braces to find the method body.
		const startMatch = src.match(/async\s+didClose\s*\([^)]*\)\s*:\s*Promise<void>\s*\{/);
		expect(startMatch, "didClose method must be locatable in lsp/client.ts").not.toBeNull();
		const startIdx = startMatch!.index! + startMatch![0].length; // position just after `{`
		let depth = 1;
		let endIdx = -1;
		for (let i = startIdx; i < src.length; i++) {
			const ch = src[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					endIdx = i;
					break;
				}
			}
		}
		expect(endIdx, "didClose method body must be brace-balanced").not.toBe(-1);
		const body = src.slice(startIdx, endIdx);

		// Must contain a try { ... } finally { ... } block.
		expect(body).toMatch(/try\s*\{/);
		expect(body).toMatch(/finally\s*\{/);

		// The deletes must be inside the finally block (after `finally {`).
		const finallyIdx = body.indexOf("finally");
		const finallyBody = body.slice(finallyIdx);
		expect(finallyBody).toMatch(/_docVersions\.delete\s*\(/);
		expect(finallyBody).toMatch(/_openedFiles\.delete\s*\(/);

		// And the deletes must NOT appear before the try block (i.e., the
		// old "delete after the await" pattern must be gone).
		const tryIdx = body.indexOf("try");
		const beforeTry = body.slice(0, tryIdx);
		expect(beforeTry).not.toMatch(/_docVersions\.delete\s*\(/);
		expect(beforeTry).not.toMatch(/_openedFiles\.delete\s*\(/);
	});
});

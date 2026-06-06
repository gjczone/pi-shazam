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
	});

	describe("LspClient protocol methods", () => {
		let client: LspClient;

		beforeEach(() => {
			client = new LspClient(["mock"], "/ws", 5000);
		});

		it("should expose didOpen method", () => {
			expect(typeof client.didOpen).toBe("function");
		});

		it("should expose request method", () => {
			expect(typeof client.request).toBe("function");
		});

		it("should expose close method", () => {
			expect(typeof client.close).toBe("function");
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
		(client as any)._notifications = [{ uri: "file:///test.ts", diagnostics: [] }];
		(client as any)._serverCapabilities = { hoverProvider: true };

		const closeResult = client.close();
		expect(closeResult).toBeInstanceOf(Promise);
		await closeResult;

		expect((client as any)._notifications).toEqual([]);
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
});

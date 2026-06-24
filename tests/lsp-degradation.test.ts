/**
 * pi-shazam tests/lsp-degradation -- Verify graceful degradation when
 * vscode-jsonrpc/node module is unavailable (issue #441).
 *
 * These tests simulate a missing vscode-jsonrpc/node dependency by mocking
 * createRequire to throw MODULE_NOT_FOUND. The extension MUST load without
 * crashing and fall back to tree-sitter only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Mock: vscode-jsonrpc/node missing ──────────────────────────────────────

// Use vi.hoisted() to hold state that survives vi.mock hoisting.
// The mock factory runs at hoist time, before module-level code.
// vi.hoisted() results are available in both phases.
const hoisted = vi.hoisted(() => {
	let _realCreateRequire: ((url: string | URL) => NodeRequire) | null = null;
	return {
		setReal(fn: (url: string | URL) => NodeRequire) {
			_realCreateRequire = fn;
		},
		getReal(): (url: string | URL) => NodeRequire {
			return _realCreateRequire!;
		},
	};
});

vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	hoisted.setReal(actual.createRequire);
	return {
		...actual,
		createRequire: vi.fn((_url: string | URL) => (moduleName: string) => {
			if (moduleName === "vscode-jsonrpc/node") {
				const err = new Error(
					"Cannot find module 'vscode-jsonrpc/node'\n" + "Require stack:\n" + "- /fake/lsp/client.js",
				) as NodeJS.ErrnoException;
				err.code = "MODULE_NOT_FOUND";
				throw err;
			}
			// For any other dynamic require, use the real createRequire
			return hoisted.getReal()(import.meta.url)(moduleName);
		}),
	};
});

// Mock child_process spawn
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { LspClient } from "../lsp/client.js";

// ── Helpers ────────────────────────────────────────────────────────────────

class MockProcess extends EventEmitter {
	exitCode: number | null = null;
	killed = false;
	pid = 12345;
	stdin = { on: vi.fn(), write: vi.fn() };
	stdout = { on: vi.fn() };
	stderr = { on: vi.fn() };

	kill(_signal?: string): boolean {
		this.killed = true;
		this.exitCode = this.exitCode ?? 1;
		this.emit("exit", this.exitCode, _signal);
		return true;
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("LSP degradation when vscode-jsonrpc/node is missing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should construct LspClient without throwing when rpc module is missing", () => {
		const client = new LspClient(["mock-server"], "/test/workspace", 5000);
		expect(client).toBeDefined();
		expect(client.isRunning()).toBe(false);
		expect(client.isInitialized()).toBe(false);
	});

	it("should not throw when start() is called without rpc module", () => {
		const client = new LspClient(["mock-server"], "/test/workspace", 5000);
		const logMessages: string[] = [];
		(client as any)._log = (msg: string) => logMessages.push(msg);

		// start() should not throw even though rpc is unavailable
		expect(() => client.start()).not.toThrow();
		expect(client.isRunning()).toBe(false);

		// Should have logged the reason
		const rpcMsg = logMessages.find(
			(m) => m.toLowerCase().includes("rpc") || m.toLowerCase().includes("vscode-jsonrpc"),
		);
		expect(rpcMsg).toBeDefined();
	});

	it("should not throw when close() is called on unstarted client (rpc missing)", async () => {
		const client = new LspClient(["mock-server"], "/test/workspace", 5000);
		await expect(client.close()).resolves.toBeUndefined();
		expect(client.isRunning()).toBe(false);
	});

	it("should return ok/null for protocol methods when rpc module is missing", async () => {
		const client = new LspClient(["mock-server"], "/test/workspace", 5000);

		// didOpen should throw because connection is null
		await expect(client.didOpen("/test/file.ts", "content")).rejects.toThrow();

		// definition should return ok with null data when file not opened
		const defResult = await client.definition("/test/file.ts", 0, 0);
		expect(defResult.status).toBe("ok");
		expect(defResult.data).toBeNull();

		// references should return ok with null data
		const refResult = await client.references("/test/file.ts", 0, 0);
		expect(refResult.status).toBe("ok");
		expect(refResult.data).toBeNull();
	});

	it("should reject initialize() when rpc module is missing", async () => {
		const client = new LspClient(["mock-server"], "/test/workspace", 5000);
		await expect(client.initialize()).rejects.toThrow();
	});

	it("should not crash when start() is called and process spawns but rpc is null", () => {
		const proc = new MockProcess();
		const spawnMock = spawn as any as ReturnType<typeof vi.fn>;
		spawnMock.mockReturnValue(proc);

		const client = new LspClient(["mock-server"], "/test/workspace", 5000);
		const logMessages: string[] = [];
		(client as any)._log = (msg: string) => logMessages.push(msg);

		// Even with a spawned process, start() should detect rpc is null
		// and not attempt to create readers/writers/connection
		expect(() => client.start()).not.toThrow();

		// Should be running=false because rpc guard prevents connection setup
		expect(client.isRunning()).toBe(false);
	});

	it("should collectDiagnostics return empty without rpc", () => {
		const client = new LspClient(["mock-server"], "/test/workspace", 5000);

		// No files opened
		const diags = client.collectDiagnostics(["/test/file.ts"]);
		expect(diags).toEqual([]);
	});

	it("should cancelInflight not throw without rpc", () => {
		const client = new LspClient(["mock-server"], "/test/workspace", 5000);

		expect(() => client.cancelInflight()).not.toThrow();
	});
});

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LspClient } from "../lsp/client.js";

// ── Test A: LSP initialize timeout must be 30000ms (issue #694) ────────────────

// Runtime assertion: spy on the client's _sendRequest and verify that the
// "initialize" call passes an explicit timeoutMs of 30000, while other
// requests keep falling back to this.timeout.
describe("LSP initialize timeout raised to 30s (#694)", () => {
	it("passes timeoutMs 30000 for the initialize request", async () => {
		const conn = {
			sendRequest: vi.fn().mockResolvedValue({ capabilities: {} }),
			sendNotification: vi.fn(),
			onNotification: vi.fn(),
			listen: vi.fn(),
			dispose: vi.fn(),
		};

		const client = new LspClient(["mock-server", "--stdio"], "/test/workspace", 8000);

		// Inject a running connection + process without a real handshake.
		(client as any).connection = conn;
		(client as any).process = {
			pid: 1,
			killed: false,
			kill() {},
			on() {},
			stdin: { write() {} },
			stdout: { on() {} },
			stderr: { on() {} },
		};
		(client as any)._running = true;

		const spy = vi.spyOn(client as any, "_sendRequest");

		await client.initialize();

		// Find the initialize call: method === "initialize"
		const initCall = spy.mock.calls.find((c: any[]) => c[0] === "initialize");
		expect(initCall, "initialize request should be sent via _sendRequest").toBeDefined();
		// timeoutMs is the 3rd positional argument
		expect(initCall![2]).toBe(30000);

		spy.mockRestore();
	});

	it("does not change the global default timeout (this.timeout stays 8000)", () => {
		const client = new LspClient(["mock-server", "--stdio"], "/test/workspace", 8000);
		expect(client.timeout).toBe(8000);
	});

	it("source still forwards initialize with explicit 30000", () => {
		const content = readFileSync("lsp/client.ts", "utf-8");
		expect(content).toMatch(/"initialize"\s*,\s*\w+\s*,\s*30000/);
	});
});

// ── Test B: diagnostic poll constants (issue #694) ──────────────────────────────

describe("verify diagnostic poll raised to 10s (#694)", () => {
	it("MAX_POLL_ATTEMPTS is 20 and POLL_INTERVAL_MS is 500", () => {
		const content = readFileSync("tools/verify.ts", "utf-8");
		expect(content).toMatch(/const MAX_POLL_ATTEMPTS = 20;/);
		expect(content).toMatch(/const POLL_INTERVAL_MS = 500;/);
	});
});

import { describe, it, expect, beforeEach } from "vitest";
import { LspClient } from "../lsp/client.js";

describe("lsp/client", () => {
	describe("LspClient constructor", () => {
		it("should create an LspClient instance", () => {
			const client = new LspClient(
				["mock-server", "--stdio"],
				"/test/workspace",
				5000,
			);
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
			// Note: start/stop tested in integration; unit test verifies API shape
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

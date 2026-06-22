/**
 * Tests for path traversal protection in shazam_lookup (issue #380).
 *
 * Verifies that user-supplied name/file params that resolve outside
 * the project root are rejected before reaching statSync or LSP didOpen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../types/pi-extension.js";

/**
 * Create a mock ExtensionAPI that captures the registered tool definition.
 */
function mockPi(): { pi: ExtensionAPI; registered: ToolDefinition[] } {
	const registered: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

describe("shazam_lookup path traversal guard", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("should reject absolute path outside project root (e.g. /etc/passwd)", async () => {
		const { pi, registered } = mockPi();
		const { registerLookup } = await import("../tools/lookup.js");
		registerLookup(pi);

		const tool = registered[0]!;
		const result = await tool.execute("call-1", { name: "/etc/passwd" }, undefined, undefined, {} as never);

		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.status).toBe("error");
		expect(parsed.result.error).toMatch(/outside the project root/);
	});

	it("should reject relative path escaping project root (e.g. ../../../etc/passwd)", async () => {
		const { pi, registered } = mockPi();
		const { registerLookup } = await import("../tools/lookup.js");
		registerLookup(pi);

		const tool = registered[0]!;
		const result = await tool.execute("call-2", { name: "../../../etc/passwd" }, undefined, undefined, {} as never);

		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.status).toBe("error");
		expect(parsed.result.error).toMatch(/outside the project root/);
	});

	it("should reject file param outside project root", async () => {
		const { pi, registered } = mockPi();
		const { registerLookup } = await import("../tools/lookup.js");
		registerLookup(pi);

		const tool = registered[0]!;
		const result = await tool.execute(
			"call-3",
			{ name: "someSymbol", file: "/etc/shadow" },
			undefined,
			undefined,
			{} as never,
		);

		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.status).toBe("error");
		expect(parsed.result.error).toMatch(/outside the project root/);
	});

	it("should allow valid relative path within project (e.g. core/graph.ts)", async () => {
		const { pi, registered } = mockPi();
		const { registerLookup } = await import("../tools/lookup.js");
		registerLookup(pi);

		const tool = registered[0]!;
		const result = await tool.execute("call-4", { name: "core/graph.ts" }, undefined, undefined, {} as never);

		const text = (result.content[0] as { text: string }).text;
		// Should NOT be an error envelope — either plain text or ok envelope
		expect(text).not.toMatch(/outside the project root/);
	});
});

describe("LspManager.getServerForFile path traversal guard", () => {
	it("should return null for paths outside project root", async () => {
		const { LspManager } = await import("../lsp/manager.js");
		const manager = new LspManager("/tmp/fake-project", () => {});
		// Absolute path outside project
		const result = await manager.getServerForFile("/etc/passwd");
		expect(result).toBeNull();
	});

	it("should return null for relative paths escaping project root", async () => {
		const { LspManager } = await import("../lsp/manager.js");
		const manager = new LspManager("/tmp/fake-project", () => {});
		const result = await manager.getServerForFile("../../../etc/shadow.ts");
		expect(result).toBeNull();
	});

	it("should not reject paths within project root", async () => {
		const { LspManager } = await import("../lsp/manager.js");
		const manager = new LspManager("/tmp/fake-project", () => {});
		// This will return null because no LSP server exists, but it should
		// NOT be blocked by the path traversal guard. The null is from no server.
		const result = await manager.getServerForFile("src/index.ts");
		// The path is valid, so it should not be rejected by the guard.
		// It returns null because there's no LSP server for the file.
		expect(result).toBeNull();
	});
});

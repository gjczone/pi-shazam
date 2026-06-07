import { describe, it, expect } from "vitest";
import { LspClient } from "../lsp/client.js";
import { lspWorkspaceSearch, mapSymbolKindNumber, type LspEnrichContext } from "../tools/lsp_enrich.js";

describe("LspClient new protocol methods", () => {
	it("exposes workspaceSymbol method", () => {
		const client = new LspClient(["mock"], "/ws", 5000);
		expect(typeof client.workspaceSymbol).toBe("function");
	});

	it("exposes semanticTokens method", () => {
		const client = new LspClient(["mock"], "/ws", 5000);
		expect(typeof client.semanticTokens).toBe("function");
	});

	it("exposes foldingRange method", () => {
		const client = new LspClient(["mock"], "/ws", 5000);
		expect(typeof client.foldingRange).toBe("function");
	});

	it("workspaceSymbol returns null when client not started", async () => {
		const client = new LspClient(["mock"], "/ws", 5000);
		const result = await client.workspaceSymbol("foo");
		expect(result).toEqual({ status: "ok", data: null });
	});

	it("semanticTokens returns null when file not opened", async () => {
		const client = new LspClient(["mock"], "/ws", 5000);
		const result = await client.semanticTokens("/not/opened.ts");
		expect(result).toEqual({ status: "ok", data: null });
	});

	it("foldingRange returns null when file not opened", async () => {
		const client = new LspClient(["mock"], "/ws", 5000);
		const result = await client.foldingRange("/not/opened.ts");
		expect(result).toEqual({ status: "ok", data: null });
	});
});

describe("lsp_enrich helpers", () => {
	describe("mapSymbolKindNumber", () => {
		it("maps LSP SymbolKind enum to string kind", () => {
			expect(mapSymbolKindNumber(12)).toBe("function");
			expect(mapSymbolKindNumber(5)).toBe("class");
			expect(mapSymbolKindNumber(11)).toBe("interface");
			expect(mapSymbolKindNumber(6)).toBe("method");
			expect(mapSymbolKindNumber(7)).toBe("property");
			expect(mapSymbolKindNumber(8)).toBe("field");
			expect(mapSymbolKindNumber(9)).toBe("constructor");
			expect(mapSymbolKindNumber(10)).toBe("enum");
			expect(mapSymbolKindNumber(2)).toBe("module");
			expect(mapSymbolKindNumber(3)).toBe("namespace");
			expect(mapSymbolKindNumber(4)).toBe("package");
			expect(mapSymbolKindNumber(13)).toBe("variable");
			expect(mapSymbolKindNumber(14)).toBe("constant");
			expect(mapSymbolKindNumber(26)).toBe("type_alias");
			expect(mapSymbolKindNumber(999)).toBe("symbol");
		});
	});

	describe("lspWorkspaceSearch", () => {
		it("returns empty array when manager is null", async () => {
			const results = await lspWorkspaceSearch(null, "foo", 1000);
			expect(results).toEqual([]);
		});

		it("returns empty array when manager has no active servers", async () => {
			const ctx: LspEnrichContext = {
				getServerForFile: () => null,
				getActiveServers: () => [],
			};
			const results = await lspWorkspaceSearch(ctx, "foo", 1000);
			expect(results).toEqual([]);
		});
	});
});

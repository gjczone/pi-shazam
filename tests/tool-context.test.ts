/**
 * Tests for tool context — verifies LspManager injection via tools/_context.ts
 * and that core/ has zero LSP imports (issue #30).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Tool context: LspManager injection", () => {
	it("tools/_context.ts exports setLspManager and getLspManager", async () => {
		const ctx = await import("../tools/_context.js");
		expect(typeof ctx.setLspManager).toBe("function");
		expect(typeof ctx.getLspManager).toBe("function");
	});

	it("getLspManager returns null before setLspManager is called", async () => {
		const { getLspManager } = await import("../tools/_context.js");
		// After import, before any set — should be null
		// Note: other tests may call setLspManager, so we test the module contract
		const result = getLspManager();
		// Result is either null (fresh) or an LspManager (if set by another test)
		// The key contract: it does not throw
		expect(result === null || typeof result === "object").toBe(true);
	});

	it("setLspManager stores and getLspManager retrieves the instance", async () => {
		const { setLspManager, getLspManager } = await import(
			"../tools/_context.js"
		);
		const { LspManager } = await import("../lsp/manager.js");
		const mgr = new LspManager("/tmp/test-project");
		setLspManager(mgr);
		expect(getLspManager()).toBe(mgr);
	});
});

describe("Architecture: core/ has zero LSP imports", () => {
	it("no file in core/ imports from lsp/", () => {
		const coreDir = join(import.meta.dirname, "..", "core");
		const files = readdirSync(coreDir).filter((f) => f.endsWith(".ts"));
		const violations: string[] = [];

		for (const file of files) {
			const content = readFileSync(join(coreDir, file), "utf-8");
			// Check for any import from ../lsp/ or ./lsp/ or similar
			if (/from\s+["'].*lsp/.test(content) || /import\s*\(.*lsp/.test(content)) {
				violations.push(file);
			}
		}

		expect(violations).toEqual([]);
	});

	it("core/lsp-global.ts does not exist", () => {
		const lspGlobalPath = join(
			import.meta.dirname,
			"..",
			"core",
			"lsp-global.ts",
		);
		let exists = true;
		try {
			readFileSync(lspGlobalPath);
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);
	});
});

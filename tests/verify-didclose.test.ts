/**
 * Tests for LSP didClose cleanup after verify (#626).
 *
 * In long-lived MCP mode, verify opens up to maxFiles files via LSP didOpen
 * but never sends didClose. The language server holds AST for each open
 * document, so memory grows linearly with the number of files opened across
 * the MCP process lifetime. The fix is to close opened files after diagnostics
 * collection completes, both on the LSP client (_openedFiles) and the
 * manager-level crash-recovery map (_openedFilePaths).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { LspManager } from "../lsp/manager.js";

/**
 * Inject mock LspClient instances into an LspManager for unit testing.
 * Avoids spawning real LSP processes.
 */
function injectMockServers(manager: LspManager, languages: string[]): void {
	for (const lang of languages) {
		const didOpen = async (_filePath: string, _text: string) => {};
		const didClose = async (_filePath: string) => {};
		const isFileOpened = (_filePath: string) => true;
		const collectDiagnostics = (_filePaths: string[], _consume?: boolean) => [];
		const close = async () => {};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(manager as any).servers.set(lang, {
			language: lang,
			serverName: `mock-${lang}`,
			client: { didOpen, didClose, isFileOpened, collectDiagnostics, close },
		});
	}
}

describe("LspManager: closeOpenedFiles (#626)", () => {
	let manager: LspManager;

	beforeEach(() => {
		manager = new LspManager("/test/project");
		injectMockServers(manager, ["typescript", "python"]);
	});

	it("sends didClose to all opened files and clears _openedFilePaths", async () => {
		// Pre-populate the crash-recovery map as if verify had opened these
		manager.trackOpenedFile("typescript", "src/a.ts");
		manager.trackOpenedFile("typescript", "src/b.ts");
		manager.trackOpenedFile("python", "src/c.py");

		// Track didClose calls
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tsClient = (manager as any).servers.get("typescript").client;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const pyClient = (manager as any).servers.get("python").client;
		const tsDidClose = vi.spyOn(tsClient, "didClose");
		const pyDidClose = vi.spyOn(pyClient, "didClose");

		// Act
		await manager.closeOpenedFiles();

		// didClose called for every opened file
		expect(tsDidClose).toHaveBeenCalledTimes(2);
		expect(tsDidClose).toHaveBeenCalledWith("src/a.ts");
		expect(tsDidClose).toHaveBeenCalledWith("src/b.ts");
		expect(pyDidClose).toHaveBeenCalledTimes(1);
		expect(pyDidClose).toHaveBeenCalledWith("src/c.py");

		// _openedFilePaths cleared
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const openedPaths = (manager as any)._openedFilePaths as Map<string, Set<string>>;
		for (const set of openedPaths.values()) {
			expect(set.size).toBe(0);
		}
	});

	it("is a no-op when no files have been opened", async () => {
		// No pre-population — empty map
		await expect(manager.closeOpenedFiles()).resolves.toBeUndefined();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const openedPaths = (manager as any)._openedFilePaths as Map<string, Set<string>>;
		expect(openedPaths.size).toBe(0);
	});

	it("continues cleanup even if a single didClose throws", async () => {
		manager.trackOpenedFile("typescript", "src/a.ts");
		manager.trackOpenedFile("typescript", "src/b.ts");
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tsClient = (manager as any).servers.get("typescript").client;
		// First didClose rejects, second should still run
		const spy = vi
			.spyOn(tsClient, "didClose")
			.mockImplementationOnce(async () => {
				throw new Error("connection disposed");
			})
			.mockImplementation(async () => {});

		await manager.closeOpenedFiles();

		// Both didClose calls attempted
		expect(spy).toHaveBeenCalledTimes(2);

		// Map cleared even though one call failed (best-effort cleanup)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const openedPaths = (manager as any)._openedFilePaths as Map<string, Set<string>>;
		for (const set of openedPaths.values()) {
			expect(set.size).toBe(0);
		}
	});
});

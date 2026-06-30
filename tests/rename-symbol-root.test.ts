/**
 * Tests for issue #535: executeRenameSymbol defaults to getEffectiveRoot(), not process.cwd().
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setProjectRoot, resetProjectRoot, scanProject } from "../core/scanner.js";
import { setLspManager, getLspManager } from "../tools/_context.js";
import { executeRenameSymbol } from "../tools/rename_symbol.js";
import type { LspManager } from "../lsp/manager.js";
import type { LspClient } from "../lsp/client.js";
import type { WorkspaceEdit } from "vscode-languageserver-protocol";

const testDirs: string[] = [];

function makeTestDir(name: string): string {
	const dir = resolve(join(process.cwd(), ".test-535-" + name + "-" + Date.now()));
	mkdirSync(dir, { recursive: true });
	testDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (testDirs.length) {
		const dir = testDirs.pop()!;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	}
	resetProjectRoot();
});

describe("executeRenameSymbol default projectRoot (#535)", () => {
	it("should use getEffectiveRoot() as default, not process.cwd()", async () => {
		// Create a subdirectory within process.cwd() to act as project root
		const projectDir = makeTestDir("proj");
		mkdirSync(join(projectDir, "src"), { recursive: true });
		const targetFile = join(projectDir, "src", "target.ts");
		writeFileSync(targetFile, "export function myFunc() { return 1; }\n");

		// Create a sibling file within process.cwd() but OUTSIDE the project root
		const outsideFile = join(process.cwd(), ".test-535-outside-" + Date.now() + ".ts");
		writeFileSync(outsideFile, "// outside project\n");
		testDirs.push(outsideFile);

		// Set project root to the subdirectory (this is what Pi does via setProjectRoot)
		setProjectRoot(projectDir);

		// Verify that getEffectiveRoot() returns projectDir, not process.cwd()
		const { getEffectiveRoot } = await import("../core/scanner.js");
		expect(getEffectiveRoot()).toBe(projectDir);
		expect(getEffectiveRoot()).not.toBe(process.cwd());

		const graph = scanProject(projectDir);

		// Create a mock LSP client that returns an edit for the outside file
		const mockClient = {
			isRunning: () => true,
			isInitialized: () => true,
			isFileOpened: () => false,
			rename: vi.fn().mockResolvedValue({
				status: "ok",
				data: {
					changes: {
						["file://" + outsideFile]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
								newText: "",
							},
						],
					},
				} as WorkspaceEdit,
			}),
			didOpen: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			initialize: vi.fn().mockResolvedValue(undefined),
		} as unknown as LspClient;

		const mockManager = {
			getServerForFile: vi.fn().mockResolvedValue({
				language: "typescript",
				serverName: "tsserver",
				client: mockClient,
				command: ["tsserver"],
				workspaceRoot: projectDir,
				source: "path" as const,
			}),
			shutdown: vi.fn().mockResolvedValue(undefined),
			trackOpenedFile: vi.fn(),
		} as unknown as LspManager;

		const originalManager = getLspManager();
		await setLspManager(mockManager);

		try {
			// Call executeRenameSymbol WITHOUT explicit projectRoot.
			// This tests the DEFAULT parameter value.
			const result = await executeRenameSymbol(graph, "myFunc", "renamedFunc", true);

			// The outside file is WITHIN process.cwd() but OUTSIDE projectDir.
			// With the BUG (default = process.cwd()): validatePathInProject(outsideFile, process.cwd())
			//   would resolve outsideFile against process.cwd() -> it IS inside -> ACCEPTED (security issue!)
			// With the FIX (default = getEffectiveRoot() = projectDir):
			//   validatePathInProject(outsideFile, projectDir) -> outsideFile resolves OUTSIDE projectDir -> REJECTED
			expect(result.status).toBe("ok");
			const skippedEntry = result.edits?.find((e) => e.file === outsideFile && e.text.includes("escapes project root"));
			expect(skippedEntry).toBeDefined();
		} finally {
			await setLspManager(originalManager!);
		}
	});
});

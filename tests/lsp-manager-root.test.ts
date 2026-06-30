/**
 * Tests for LspManager.setProjectRoot (issue #241, #536).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LspManager } from "../lsp/manager.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-shazam-536-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop()!;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	}
});

describe("LspManager.setProjectRoot", () => {
	it("should update projectRoot when a new path is provided", () => {
		const log = vi.fn();
		const manager = new LspManager("/original/root", log);
		manager.setProjectRoot("/new/root");
		expect(() => manager.detectLanguages()).not.toThrow();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("/new/root"));
	});

	it("should be a no-op when the resolved path is unchanged", () => {
		const log = vi.fn();
		const manager = new LspManager("/project", log);
		manager.setProjectRoot("/project");
		expect(log).not.toHaveBeenCalled();
	});

	it("should clear tracked opened files when root changes (#536)", () => {
		const rootA = makeTempDir();
		const rootB = makeTempDir();
		const log = vi.fn();
		const manager = new LspManager(rootA, log);
		manager.trackOpenedFile("typescript", "src/file.ts");
		manager.trackOpenedFile("typescript", "src/other.ts");
		const tracked = (manager as unknown as { _openedFilePaths: Map<string, Set<string>> })._openedFilePaths;
		expect(tracked.get("typescript")?.size).toBe(2);
		manager.setProjectRoot(rootB);
		expect(tracked.get("typescript")?.size ?? 0).toBe(0);
	});

	it("should NOT clear tracked files when root is unchanged (#536)", () => {
		const root = makeTempDir();
		const log = vi.fn();
		const manager = new LspManager(root, log);
		manager.trackOpenedFile("typescript", "src/file.ts");
		const tracked = (manager as unknown as { _openedFilePaths: Map<string, Set<string>> })._openedFilePaths;
		manager.setProjectRoot(root);
		expect(tracked.get("typescript")?.size).toBe(1);
	});
});

describe("LspManager path containment (#536)", () => {
	it("should reject out-of-root relative paths in getServerForFile", async () => {
		const root = makeTempDir();
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "file.ts"), "export const x = 1;\n");
		const manager = new LspManager(root);
		const result = await manager.getServerForFile("../outside-project/secret.txt");
		// Path escapes root -> must return null immediately without trying to init a server
		expect(result).toBeNull();
	});
});

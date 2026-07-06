/**
 * Tests for LSP per-file mtime cache invalidation (#641).
 *
 * Root cause: when a source file's content changed between verify calls, the
 * LSP server's per-document AST cache returned phantom diagnostics against the
 * OLD content. The fix is to record the file mtime at didOpen time and send
 * `textDocument/didClose` for the stale version before `didOpen` of the new
 * content.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager } from "../lsp/manager.js";

/**
 * Inject mock LspClient instances into an LspManager for unit testing.
 * Avoids spawning real LSP processes. Tracks didOpen / didClose call counts
 * and exposes spies so each test can assert what was sent.
 */
function injectMockServers(
	manager: LspManager,
	languages: string[],
): {
	didOpen: ReturnType<typeof vi.fn>;
	didClose: ReturnType<typeof vi.fn>;
	collectDiagnostics: ReturnType<typeof vi.fn>;
} {
	const didOpen = vi.fn(async (_filePath: string, _text: string) => {});
	const didClose = vi.fn(async (_filePath: string) => {});
	const collectDiagnostics = vi.fn((_filePaths: string[], _consume?: boolean) => []);
	const close = vi.fn(async () => {});
	for (const lang of languages) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(manager as any).servers.set(lang, {
			language: lang,
			serverName: `mock-${lang}`,
			client: { didOpen, didClose, isFileOpened: () => true, collectDiagnostics, close },
		});
	}
	return { didOpen, didClose, collectDiagnostics };
}

describe("LspManager: invalidateIfStale (#641)", () => {
	let manager: LspManager;
	let didOpen: ReturnType<typeof vi.fn>;
	let didClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		manager = new LspManager("/test/project");
		({ didOpen, didClose } = injectMockServers(manager, ["typescript"]));
	});

	it("sends didClose when file mtime is newer than recorded", async () => {
		// Pre-populate the mtime map as if a prior verify cycle opened this file
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(manager as any)._openedFileMtimes.set("src/a.ts", 1000);

		// Act: caller passes a newer mtime (file was edited since)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const invalidated = await (manager as any).invalidateIfStale("src/a.ts", 2000);

		expect(invalidated).toBe(true);
		expect(didClose).toHaveBeenCalledTimes(1);
		expect(didClose).toHaveBeenCalledWith("src/a.ts");
		// Entry removed so a subsequent didOpen won't be blocked
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((manager as any)._openedFileMtimes.has("src/a.ts")).toBe(false);
	});

	it("does not send didClose when mtime is unchanged", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(manager as any)._openedFileMtimes.set("src/a.ts", 1000);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const invalidated = await (manager as any).invalidateIfStale("src/a.ts", 1000);

		expect(invalidated).toBe(false);
		expect(didClose).not.toHaveBeenCalled();
		// Entry preserved
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((manager as any)._openedFileMtimes.get("src/a.ts")).toBe(1000);
	});

	it("does not send didClose when file is not in the mtime map", async () => {
		// No prior open recorded for this file
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const invalidated = await (manager as any).invalidateIfStale("src/untracked.ts", 5000);

		expect(invalidated).toBe(false);
		expect(didClose).not.toHaveBeenCalled();
	});

	it("does not throw when the client didClose rejects", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(manager as any)._openedFileMtimes.set("src/a.ts", 1000);
		didClose.mockRejectedValueOnce(new Error("connection disposed"));

		// Act + assert: must not throw (best-effort)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const invalidated = await (manager as any).invalidateIfStale("src/a.ts", 2000);

		expect(invalidated).toBe(true);
		// Entry still cleared so a follow-up didOpen is not blocked
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((manager as any)._openedFileMtimes.has("src/a.ts")).toBe(false);
	});

	it("clears _openedFileMtimes when _openedFilePaths is cleared", async () => {
		// Set up tracking data
		manager.trackOpenedFile("typescript", "src/a.ts", 1000);
		manager.trackOpenedFile("typescript", "src/b.ts", 2000);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((manager as any)._openedFileMtimes.size).toBe(2);

		await manager.closeOpenedFiles();

		// Both maps cleared in lockstep
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((manager as any)._openedFileMtimes.size).toBe(0);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		for (const set of (manager as any)._openedFilePaths.values()) {
			expect(set.size).toBe(0);
		}
	});
});

describe("LspManager: trackOpenedFile with mtime (#641)", () => {
	let manager: LspManager;

	beforeEach(() => {
		manager = new LspManager("/test/project");
		injectMockServers(manager, ["typescript"]);
	});

	it("records the mtime in _openedFileMtimes when provided", () => {
		manager.trackOpenedFile("typescript", "src/a.ts", 12345);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((manager as any)._openedFileMtimes.get("src/a.ts")).toBe(12345);
	});

	it("backward compatible: no mtime arg leaves _openedFileMtimes untouched", () => {
		manager.trackOpenedFile("typescript", "src/a.ts");
		// eslint-disable-next-line @typescript-eslint/no-explicitany
		expect((manager as any)._openedFileMtimes.has("src/a.ts")).toBe(false);
	});
});

describe("LspManager: invalidateIfStale with real filesystem mtime (#641)", () => {
	it("detects a real file edit between two stat() calls", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "shazam-mtime-"));
		const filePath = join(tmpDir, "real-file.ts");
		writeFileSync(filePath, "const x = 1;\n");

		const manager = new LspManager(tmpDir);
		const { didOpen, didClose } = injectMockServers(manager, ["typescript"]);

		// First stat (simulating prior verify cycle)
		const mtime1 = statSync(filePath).mtimeMs;
		manager.trackOpenedFile("typescript", filePath, mtime1);
		// Track the LspClient's internal openedFiles too so the test mirrors
		// production: the client thinks the file is open.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(manager as any).servers.get("typescript").client.isFileOpened = () => true;

		// Sleep just long enough for the filesystem mtime to advance.
		// ext4/HFS+/NTFS all have 1ms-2ms resolution; 20ms is safe.
		await new Promise((r) => setTimeout(r, 20));
		writeFileSync(filePath, "const x = 2;\n");
		const mtime2 = statSync(filePath).mtimeMs;
		expect(mtime2).toBeGreaterThan(mtime1);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const invalidated = await (manager as any).invalidateIfStale(filePath, mtime2);

		expect(invalidated).toBe(true);
		expect(didClose).toHaveBeenCalledWith(filePath);
		expect(didOpen).not.toHaveBeenCalled(); // invalidate only closes; the
		// caller (runLspDiagnostics) is responsible for the subsequent didOpen
	});
});

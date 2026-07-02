/**
 * Tests for LSP URI/path conversion and workspace-root detection (#466).
 *
 * Finding A: uriToPath must symmetrically handle Windows drive-letter URIs
 *   (file:///C:/...) by delegating to fileURLToPath, producing native paths.
 * Finding B: detectWorkspaceRoot must never walk above projectRoot, even
 *   when filePath is null (the initializeAll path) and no root marker exists.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, resolve } from "node:path";
import { uriToPath, pathToUri } from "../lsp/client.js";
import { detectLspServer } from "../lsp/manager.js";

// ---------------------------------------------------------------------------
// uriToPath (#466 Finding A)
// ---------------------------------------------------------------------------

describe("lsp/client uriToPath (#466)", () => {
	it("delegates file:// URIs to fileURLToPath (platform-native result)", () => {
		// The fix replaces manual slice/decode with fileURLToPath. On Linux
		// file:///C:/proj/foo.ts -> /C:/proj/foo.ts; on Windows -> C:\proj\foo.ts.
		// Asserting equality with fileURLToPath verifies the delegation without
		// branching on platform.
		const uri = "file:///C:/proj/foo.ts";
		expect(uriToPath(uri)).toBe(fileURLToPath(uri));
	});

	it("decodes percent-encoded characters in file URIs", () => {
		const uri = "file:///proj/a%20b.ts";
		expect(uriToPath(uri)).toBe(fileURLToPath(uri));
		expect(uriToPath(uri)).toContain("a b.ts");
	});

	it("round-trips with pathToUri on POSIX-style absolute paths", () => {
		// pathToUri calls path.resolve internally, so the round-trip
		// returns a platform-native resolved path (e.g. D:\proj\src\foo.ts
		// on Windows). Compare against path.resolve for portability.
		const abs = resolve("/proj/src/foo.ts");
		const uri = pathToUri(abs);
		expect(uriToPath(uri)).toBe(abs);
	});

	it("returns non-file URIs unchanged", () => {
		expect(uriToPath("urn:uuid:abc")).toBe("urn:uuid:abc");
	});

	it("on Windows, file:///C:/proj/foo.ts yields C:\\proj\\foo.ts", () => {
		// Platform-guarded assertion: only meaningful on win32, but documents
		// the contract the fix restores (symmetric with pathToUri from #429).
		if (process.platform !== "win32") return;
		expect(uriToPath("file:///C:/proj/foo.ts")).toBe(`C:${sep}proj${sep}foo.ts`);
	});
});

// ---------------------------------------------------------------------------
// detectWorkspaceRoot (#466 Finding B)
//
// detectWorkspaceRoot is not exported; tested indirectly via detectLspServer,
// which returns `workspaceRoot` in every result path.
// ---------------------------------------------------------------------------

describe("lsp/manager detectWorkspaceRoot (#466)", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "shazam-466-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns projectRoot when filePath is null and no marker exists (initializeAll path)", () => {
		// No package.json anywhere -> must NOT walk above projectRoot.
		const result = detectLspServer(tmpRoot, "typescript", null);
		expect(result.workspaceRoot).toBe(tmpRoot);
	});

	it("returns projectRoot when filePath is undefined", () => {
		const result = detectLspServer(tmpRoot, "typescript", undefined);
		expect(result.workspaceRoot).toBe(tmpRoot);
	});

	it("returns projectRoot when filePath sits inside it and no marker exists", () => {
		const subDir = join(tmpRoot, "src");
		mkdirSync(subDir, { recursive: true });
		const filePath = join(subDir, "foo.ts");
		writeFileSync(filePath, "");
		const result = detectLspServer(tmpRoot, "typescript", filePath);
		expect(result.workspaceRoot).toBe(tmpRoot);
	});

	it("returns projectRoot when marker exists at projectRoot", () => {
		writeFileSync(join(tmpRoot, "package.json"), "{}");
		const result = detectLspServer(tmpRoot, "typescript", null);
		expect(result.workspaceRoot).toBe(tmpRoot);
	});

	it("returns the marker directory when marker exists in a subdir of filePath", () => {
		// filePath deep inside src; package.json at src -> workspaceRoot = src
		const srcPkg = join(tmpRoot, "src");
		const deep = join(srcPkg, "deep", "deeper");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(srcPkg, "package.json"), "{}");
		const filePath = join(deep, "foo.ts");
		writeFileSync(filePath, "");
		const result = detectLspServer(tmpRoot, "typescript", filePath);
		expect(result.workspaceRoot).toBe(srcPkg);
	});

	it("NEVER escapes above projectRoot even when an ancestor has a marker", () => {
		// Create a package.json in an ANCESTOR of projectRoot. The old code
		// walked up and would return the ancestor; the fix must clamp at
		// projectRoot.
		const ancestor = mkdtempSync(join(tmpdir(), "shazam-466-anc-"));
		try {
			// Re-create tmpRoot as a child of ancestor so we control the parent.
			const childName = "proj";
			const childRoot = join(ancestor, childName);
			mkdirSync(childRoot, { recursive: true });
			// Marker in ancestor (above projectRoot)
			writeFileSync(join(ancestor, "package.json"), "{}");

			const result = detectLspServer(childRoot, "typescript", null);
			expect(result.workspaceRoot).toBe(childRoot);
		} finally {
			rmSync(ancestor, { recursive: true, force: true });
		}
	});
});

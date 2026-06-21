/**
 * Tests for non-git directory handling (issue #350).
 *
 * Verifies that the extension gracefully degrades when the project
 * directory is not a git repository — no crashes, no stderr pollution,
 * no blocking behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateOverviewForPrompt, resetOverviewShown } from "../hooks/before-start.js";
import { resolveGitWorkdir } from "../tools/verify.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-nogit-"));
	resetOverviewShown();
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort cleanup */
	}
});

describe("Issue #350: Non-git directory handling", () => {
	describe("generateOverviewForPrompt", () => {
		it("should NOT throw on empty non-git directory", () => {
			expect(() => generateOverviewForPrompt(tmpDir)).not.toThrow();
		});

		it("should return a valid string on non-git directory", () => {
			const result = generateOverviewForPrompt(tmpDir);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
			expect(result).toContain("[pi-shazam]");
		});

		it("should NOT include git error messages in output", () => {
			const result = generateOverviewForPrompt(tmpDir);
			// Git errors should be suppressed, not shown to users
			expect(result).not.toContain("fatal:");
			expect(result).not.toContain("not a git repository");
		});

		it("should return quickly for empty non-git directory (no scanProject)", () => {
			const start = Date.now();
			generateOverviewForPrompt(tmpDir);
			const elapsed = Date.now() - start;
			// Without scanProject, should complete in <500ms
			// (even generous threshold; real perf is <50ms)
			expect(elapsed).toBeLessThan(500);
		});

		it("should handle non-git directory with source files", () => {
			// Create a source file in the non-git dir
			writeFileSync(join(tmpDir, "hello.py"), "def hello(): pass\n");
			const result = generateOverviewForPrompt(tmpDir);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
			expect(result).toContain("[pi-shazam]");
			// Should NOT include git error output
			expect(result).not.toContain("fatal:");
		});

		it("should handle non-git directory with project marker files", () => {
			// Create a package.json (project marker) without git
			writeFileSync(join(tmpDir, "package.json"), '{"name":"test","version":"1.0.0"}');
			writeFileSync(join(tmpDir, "index.js"), "console.log('hello')\n");
			const result = generateOverviewForPrompt(tmpDir);
			expect(result).toBeDefined();
			expect(typeof result).toBe("string");
			expect(result).toContain("[pi-shazam]");
			expect(result).not.toContain("fatal:");
		});
	});

	describe("resolveGitWorkdir", () => {
		it("should fall back to cwd for non-git directory", () => {
			const result = resolveGitWorkdir(tmpDir);
			expect(result).toBe(tmpDir);
		});
	});

	// getGitChangedFiles is not exported — tested indirectly via shazam_verify tool
});

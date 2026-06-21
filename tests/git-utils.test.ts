/**
 * Tests for core/git-utils — shared git utility functions (issue #350).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isGitRepo, isProjectDir, safeGitExec, _resetGitCache } from "../core/git-utils.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-gitutils-"));
	_resetGitCache();
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe("isGitRepo", () => {
	it("should return false for non-git directory", () => {
		expect(isGitRepo(tmpDir)).toBe(false);
	});

	it("should return true for the project root (git repo)", () => {
		expect(isGitRepo(".")).toBe(true);
	});

	it("should cache results (same dir not checked twice)", () => {
		const first = isGitRepo(tmpDir);
		const second = isGitRepo(tmpDir);
		expect(first).toBe(false);
		expect(second).toBe(false);
	});
});

describe("isProjectDir", () => {
	it("should return false for empty directory", () => {
		expect(isProjectDir(tmpDir)).toBe(false);
	});

	it("should return true when package.json exists", () => {
		writeFileSync(join(tmpDir, "package.json"), "{}");
		expect(isProjectDir(tmpDir)).toBe(true);
	});

	it("should return true when Cargo.toml exists", () => {
		writeFileSync(join(tmpDir, "Cargo.toml"), "");
		expect(isProjectDir(tmpDir)).toBe(true);
	});

	it("should return true when go.mod exists", () => {
		writeFileSync(join(tmpDir, "go.mod"), "");
		expect(isProjectDir(tmpDir)).toBe(true);
	});

	it("should return true when pyproject.toml exists", () => {
		writeFileSync(join(tmpDir, "pyproject.toml"), "");
		expect(isProjectDir(tmpDir)).toBe(true);
	});

	it("should return true when pubspec.yaml exists (Dart/Flutter)", () => {
		writeFileSync(join(tmpDir, "pubspec.yaml"), "");
		expect(isProjectDir(tmpDir)).toBe(true);
	});

	it("should return true when .git exists", () => {
		writeFileSync(join(tmpDir, ".git"), "");
		expect(isProjectDir(tmpDir)).toBe(true);
	});
});

describe("safeGitExec", () => {
	it("should return null for non-git directory", () => {
		expect(safeGitExec(["log", "--oneline", "-1"], tmpDir)).toBeNull();
	});

	it("should return output for git repo", () => {
		const result = safeGitExec(["rev-parse", "--is-inside-work-tree"], ".");
		expect(result).toBe("true");
	});

	it("should return null for invalid git command", () => {
		const result = safeGitExec(["nonexistent-command"], ".");
		expect(result).toBeNull();
	});
});

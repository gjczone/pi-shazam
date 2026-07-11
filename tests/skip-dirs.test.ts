import { describe, it, expect } from "vitest";
import { SKIP_DIRS } from "../core/filter.js";

describe("SKIP_DIRS canonical set", () => {
	it("should include build output directories", () => {
		expect(SKIP_DIRS.has("node_modules")).toBe(true);
		expect(SKIP_DIRS.has("dist")).toBe(true);
		expect(SKIP_DIRS.has("build")).toBe(true);
		expect(SKIP_DIRS.has("target")).toBe(true);
	});

	it("should include venv/vendor/cache directories", () => {
		expect(SKIP_DIRS.has(".venv")).toBe(true);
		expect(SKIP_DIRS.has("venv")).toBe(true);
		expect(SKIP_DIRS.has("vendor")).toBe(true);
		expect(SKIP_DIRS.has("coverage")).toBe(true);
	});

	it("should include VCS and tooling directories", () => {
		expect(SKIP_DIRS.has(".git")).toBe(true);
		expect(SKIP_DIRS.has(".worktrees")).toBe(true);
		expect(SKIP_DIRS.has(".cache")).toBe(true);
		expect(SKIP_DIRS.has(".qoder")).toBe(true);
	});

	it("should include temp and pycache directories", () => {
		expect(SKIP_DIRS.has("tmp")).toBe(true);
		expect(SKIP_DIRS.has("temp")).toBe(true);
		expect(SKIP_DIRS.has("__pycache__")).toBe(true);
	});

	it("should include .next (canonical after #336)", () => {
		expect(SKIP_DIRS.has(".next")).toBe(true);
	});

	// Issue #720: home-directory scan guard. Add cross-platform non-source
	// tree names so `_walkDirectory` does not descend into well-known
	// platform-specific data directories when the project root happens to
	// sit under $HOME.
	it("should include snap (Ubuntu snap package tree)", () => {
		expect(SKIP_DIRS.has("snap")).toBe(true);
	});

	it("should include macOS Library/Applications/Movies/Music/Pictures", () => {
		expect(SKIP_DIRS.has("Library")).toBe(true);
		expect(SKIP_DIRS.has("Applications")).toBe(true);
		expect(SKIP_DIRS.has("Movies")).toBe(true);
		expect(SKIP_DIRS.has("Music")).toBe(true);
		expect(SKIP_DIRS.has("Pictures")).toBe(true);
	});

	it("should include Windows shell folders", () => {
		expect(SKIP_DIRS.has("Application Data")).toBe(true);
		expect(SKIP_DIRS.has("Desktop")).toBe(true);
		expect(SKIP_DIRS.has("Downloads")).toBe(true);
		expect(SKIP_DIRS.has("Documents")).toBe(true);
	});
});

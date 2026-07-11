import { describe, it, expect } from "vitest";
import { SKIP_DIRS, HOME_SKIP_DIRS } from "../core/filter.js";

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

	it("must NOT include home-scoped entries (issue #724 split)", () => {
		// Entries that may collide with real source directory names
		// (`Library`, `Documents`, ...) are gated by HOME_SKIP_DIRS so a
		// project literally named `library` is not silently skipped when
		// the user runs pi-shazam from a non-home workspace path.
		expect(SKIP_DIRS.has("snap")).toBe(false);
		expect(SKIP_DIRS.has("Library")).toBe(false);
		expect(SKIP_DIRS.has("Applications")).toBe(false);
		expect(SKIP_DIRS.has("Documents")).toBe(false);
		expect(SKIP_DIRS.has("Desktop")).toBe(false);
		expect(SKIP_DIRS.has("Downloads")).toBe(false);
		expect(SKIP_DIRS.has("Music")).toBe(false);
		expect(SKIP_DIRS.has("Movies")).toBe(false);
		expect(SKIP_DIRS.has("Pictures")).toBe(false);
		expect(SKIP_DIRS.has("Application Data")).toBe(false);
	});
});

describe("HOME_SKIP_DIRS (issue #724)", () => {
	it("includes the cross-platform non-source trees from #720", () => {
		// Linux / Ubuntu
		expect(HOME_SKIP_DIRS.has("snap")).toBe(true);
		// macOS
		expect(HOME_SKIP_DIRS.has("Library")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Applications")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Movies")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Music")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Pictures")).toBe(true);
		// Windows shell folders
		expect(HOME_SKIP_DIRS.has("Application Data")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Desktop")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Downloads")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Documents")).toBe(true);
	});

	it("does NOT overlap SKIP_DIRS (single source of truth)", () => {
		for (const entry of HOME_SKIP_DIRS) {
			expect(SKIP_DIRS.has(entry)).toBe(false);
		}
	});
});

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
});

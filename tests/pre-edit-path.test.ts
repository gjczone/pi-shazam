/**
 * Tests for hooks/pre-edit — path normalization.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getEditedFiles, clearEditedFiles, normalizeEditedPath } from "../hooks/pre-edit.js";
import { resolve } from "node:path";

describe("hooks/pre-edit path normalization", () => {
	beforeEach(() => {
		clearEditedFiles();
	});

	it("should export normalizeEditedPath function", () => {
		expect(normalizeEditedPath).toBeDefined();
		expect(typeof normalizeEditedPath).toBe("function");
	});

	it("should normalize relative paths with ./ prefix", () => {
		const a = normalizeEditedPath("./src/foo.ts", "/project");
		const b = normalizeEditedPath("src/foo.ts", "/project");
		expect(a).toBe(b);
	});

	it("should normalize paths with ../ components", () => {
		const a = normalizeEditedPath("src/../src/foo.ts", "/project");
		const b = normalizeEditedPath("src/foo.ts", "/project");
		expect(a).toBe(b);
	});

	it("should preserve absolute paths", () => {
		// Use resolve so the expected value matches the platform-native result
		const abs = resolve("/project", "src/foo.ts");
		const result = normalizeEditedPath(abs, "/project");
		expect(result).toBe(abs);
	});
});

/**
 * Tests for issue #660 and #663: Windows backslash graph keys must match
 * POSIX-anchored patterns after separator normalization.
 *
 * - #660: moduleMatchesFile compares a forward-slash resolved module against
 *   an OS-native backslash target; both sides must be normalized first.
 * - #663: isNonSourceFile tests NON_SOURCE_FILE_PATTERNS (POSIX `/` anchors)
 *   against raw file paths; backslash keys must be normalized to `/`.
 */
import { describe, it, expect } from "vitest";
import { moduleMatchesFile } from "../core/resolve-import.js";
import { isNonSourceFile } from "../core/filter.js";

describe("issue #660: moduleMatchesFile normalizes Windows separators", () => {
	it("matches a forward-slash module against a backslash target", () => {
		expect(moduleMatchesFile("src/foo.ts", "src\\foo.ts")).toBe(true);
	});

	it("matches with extension appended on a backslash target", () => {
		expect(moduleMatchesFile("src/foo", "src\\foo.ts")).toBe(true);
	});

	it("still matches POSIX paths unchanged", () => {
		expect(moduleMatchesFile("src/foo.ts", "src/foo.ts")).toBe(true);
	});

	it("returns false for genuinely different files", () => {
		expect(moduleMatchesFile("src/foo.ts", "src\\bar.ts")).toBe(false);
	});
});

describe("issue #663: isNonSourceFile normalizes Windows separators", () => {
	it("treats a backslash tsconfig.json key as non-source", () => {
		expect(isNonSourceFile("src\\tsconfig.json")).toBe(true);
	});

	it("treats a backslash node_modules path as non-source", () => {
		expect(isNonSourceFile("proj\\node_modules\\x\\y.ts")).toBe(true);
	});

	it("treats a backslash .json file as non-source", () => {
		expect(isNonSourceFile("src\\foo.json")).toBe(true);
	});

	it("still treats POSIX non-source paths correctly", () => {
		expect(isNonSourceFile("src/tsconfig.json")).toBe(true);
		expect(isNonSourceFile("src/app.ts")).toBe(false);
	});
});

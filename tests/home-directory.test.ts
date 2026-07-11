/**
 * Tests for issue #720: isHomeDirectory helper.
 *
 * The helper is the single source of truth for "is this path the current
 * user's home directory, or a direct child of it?". It powers the
 * entry-point guard in `mcp/entry.ts` and `index.ts`.
 *
 * Cross-platform behaviour:
 *  - POSIX: matches `os.homedir()` exactly, or paths that start with
 *    `homedir() + path.sep`.
 *  - Windows: case-insensitive (C:\Users\me == c:\users\me), backslash
 *    separator after resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { sep } from "node:path";
import { isHomeDirectory, isHomeDirectoryForPlatform } from "../core/path-utils.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

beforeEach(() => {
	delete process.env.HOME;
	delete process.env.USERPROFILE;
});

afterEach(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
	if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
});

describe("isHomeDirectory (issue #720)", () => {
	it("returns true for the exact home directory", () => {
		process.env.HOME = "/home/me";
		expect(isHomeDirectory("/home/me")).toBe(true);
	});

	it("returns true for a direct child of home", () => {
		process.env.HOME = "/home/me";
		expect(isHomeDirectory("/home/me/projects/foo")).toBe(true);
	});

	it("returns false for an unrelated path", () => {
		process.env.HOME = "/home/me";
		expect(isHomeDirectory("/tmp/proj")).toBe(false);
		expect(isHomeDirectory("/workspace/proj")).toBe(false);
	});

	it("returns false for a path that merely shares a prefix but is not a child", () => {
		// /home/melody must NOT match home=/home/me
		process.env.HOME = "/home/me";
		expect(isHomeDirectory("/home/melody")).toBe(false);
		expect(isHomeDirectory("/home/meadow")).toBe(false);
	});

	it("handles paths that already end with the separator", () => {
		process.env.HOME = "/home/me";
		expect(isHomeDirectory("/home/me/")).toBe(true);
	});

	it("uses the real os.homedir() when neither HOME nor USERPROFILE is set", () => {
		const home = homedir();
		// Helper should accept the actual home path.
		expect(isHomeDirectory(home)).toBe(true);
		expect(isHomeDirectory(home + sep + "Documents")).toBe(true);
	});

	// Windows coverage is exercised via isHomeDirectoryForPlatform so the
	// test does not need to mutate the global process.platform. This
	// mirrors the project's existing `normalizePathInputForPlatform`
	// parameterized helper pattern (issue #673).
	describe("isHomeDirectoryForPlatform win32 (issue #720)", () => {
		it("matches exact home and direct child case-insensitively", () => {
			expect(isHomeDirectoryForPlatform("C:\\Users\\me", "win32", "C:\\Users\\me")).toBe(true);
			expect(isHomeDirectoryForPlatform("c:\\users\\me", "win32", "C:\\Users\\me")).toBe(true);
			expect(isHomeDirectoryForPlatform("C:\\Users\\me\\project", "win32", "C:\\Users\\me")).toBe(true);
		});

		it("rejects paths outside the home directory on win32", () => {
			expect(isHomeDirectoryForPlatform("D:\\other\\proj", "win32", "C:\\Users\\me")).toBe(false);
		});

		it("rejects similarly-prefixed but unrelated paths on win32", () => {
			// C:\Users\meadow must NOT match home=C:\Users\me
			expect(isHomeDirectoryForPlatform("C:\\Users\\meadow", "win32", "C:\\Users\\me")).toBe(false);
		});
	});

	describe("isHomeDirectoryForPlatform darwin/linux (issue #720)", () => {
		it("matches exact home and direct child on darwin", () => {
			expect(isHomeDirectoryForPlatform("/Users/me", "darwin", "/Users/me")).toBe(true);
			expect(isHomeDirectoryForPlatform("/Users/me/proj", "darwin", "/Users/me")).toBe(true);
		});

		it("rejects paths outside home on linux", () => {
			expect(isHomeDirectoryForPlatform("/workspace/proj", "linux", "/home/me")).toBe(false);
		});
	});
});

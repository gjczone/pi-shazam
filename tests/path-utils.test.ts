/**
 * Tests for issue #636: file-path classification.
 *
 * Before this fix, every dispatcher conflated "path traversal" with
 * "file missing" and reported both as "outside the project root". The
 * fix introduces `classifyFilePath` in `core/path-utils.ts` which
 * distinguishes three outcomes so the LLM agent gets actionable
 * feedback ("did you mean X?") for typos but a hard stop for traversal.
 */
import { describe, it, expect } from "vitest";
import {
	classifyFilePath,
	suggestSimilarFile,
	levenshtein,
	isPathInRoot,
	normalizePathInput,
	normalizePathInputForPlatform,
} from "../core/path-utils.js";

const ROOT = process.cwd();

describe("classifyFilePath", () => {
	it("returns 'ok' for a real file in the project", () => {
		const result = classifyFilePath("package.json", ROOT);
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.path).toBe("package.json");
		}
	});

	it("returns 'traversal' for an absolute path outside the root", () => {
		const result = classifyFilePath("/etc/shadow", ROOT);
		expect(result.kind).toBe("traversal");
		if (result.kind === "traversal") {
			expect(result.path).toBe("/etc/shadow");
			expect(result.message).toMatch(/outside the project root/);
		}
	});

	it("returns 'traversal' for a relative path that escapes the root", () => {
		const result = classifyFilePath("../../../etc/passwd", ROOT);
		expect(result.kind).toBe("traversal");
	});

	it("returns 'missing' for a path inside the root that does not exist", () => {
		const result = classifyFilePath("src/this-file-does-not-exist.ts", ROOT);
		expect(result.kind).toBe("missing");
		if (result.kind === "missing") {
			expect(result.path).toBe("src/this-file-does-not-exist.ts");
		}
	});

	it("returns 'ok' for an empty path (resolves to the project root itself)", () => {
		// `resolve(".", "")` returns the current working directory, which
		// is the project root. So an empty input is the project root --
		// a valid directory. This is the documented behavior of
		// Node's `path.resolve`; classifyFilePath is consistent with it.
		const result = classifyFilePath("", ROOT);
		expect(result.kind).toBe("ok");
	});

	it("does not confuse absolute paths with project-relative paths (join vs resolve bug)", () => {
		// Regression guard: an earlier version used `path.join(root, "/abs")`
		// which on Linux silently concatenates to "<root>/abs" instead of
		// "/abs". This caused `/etc/shadow` to be misclassified as a file
		// inside the project. Use `resolve()` instead.
		const result = classifyFilePath("/etc/shadow", ROOT);
		expect(result.kind).not.toBe("ok");
	});
});

describe("suggestSimilarFile", () => {
	it("returns the closest known file within distance threshold", () => {
		const known = ["src/scanner.ts", "src/encoding.ts", "src/cache.ts"];
		// "src/scanner.tx" -> "src/scanner.ts" distance 1
		expect(suggestSimilarFile("src/scanner.tx", known)).toBe("src/scanner.ts");
	});

	it("returns undefined when no candidate is close enough", () => {
		const known = ["src/scanner.ts", "src/encoding.ts"];
		// "totally-different-name.ts" is far from every candidate.
		expect(suggestSimilarFile("totally-different-name.ts", known)).toBeUndefined();
	});

	it("honours the maxDistance parameter", () => {
		const known = ["src/scanner.ts"];
		// "src/scanner.ts" vs "src/scanner.tx" is distance 1.
		expect(suggestSimilarFile("src/scanner.tx", known, 0)).toBeUndefined();
		expect(suggestSimilarFile("src/scanner.tx", known, 2)).toBe("src/scanner.ts");
	});

	it("returns undefined for an empty known set", () => {
		expect(suggestSimilarFile("anything", [])).toBeUndefined();
	});

	it("breaks distance ties lexicographically for determinism", () => {
		const known = ["src/b.ts", "src/a.ts", "src/c.ts"];
		// "src/x.ts" -> all candidates distance 1, picks "src/a.ts" (lex smallest)
		expect(suggestSimilarFile("src/x.ts", known)).toBe("src/a.ts");
	});
});

describe("levenshtein", () => {
	it("returns 0 for identical strings", () => {
		expect(levenshtein("foo", "foo", 5)).toBe(0);
	});

	it("returns the edit distance for simple substitutions", () => {
		expect(levenshtein("kitten", "sitten", 10)).toBe(1);
		expect(levenshtein("abc", "axc", 10)).toBe(1);
	});

	it("returns the length of the non-empty string when the other is empty", () => {
		expect(levenshtein("", "abc", 10)).toBe(3);
		expect(levenshtein("abc", "", 10)).toBe(3);
	});

	it("returns cutoff+1 when the true distance exceeds the cutoff", () => {
		// "abcdefgh" -> "ijklmnop" is way more than 3 edits
		expect(levenshtein("abcdefgh", "ijklmnop", 3)).toBe(4);
	});
});

describe("isPathInRoot", () => {
	it("accepts paths inside the root", () => {
		expect(isPathInRoot(ROOT + "/src/foo.ts", ROOT)).toBe(true);
	});

	it("rejects paths outside the root", () => {
		expect(isPathInRoot("/etc/shadow", ROOT)).toBe(false);
	});

	it("accepts the root itself", () => {
		expect(isPathInRoot(ROOT, ROOT)).toBe(true);
	});

	it("rejects parent paths", () => {
		expect(isPathInRoot(ROOT + "/..", ROOT)).toBe(false);
	});
});

// Issue #673: Windows/Git-Bash path normalization.
// On Windows, a Git-Bash user passes `/c/Users/foo` and a WSL user passes
// `/mnt/c/Users/foo`. Node's `realpathSync`/`statSync` cannot resolve these
// (they treat `/c/...` as a relative path and throw ENOENT). `normalizePathInput`
// translates both styles to `C:\Users\foo` on win32 and is a no-op elsewhere.
describe("normalizePathInput", () => {
	it("leaves relative paths unchanged on every platform", () => {
		expect(normalizePathInput("src/foo.ts")).toBe("src/foo.ts");
		expect(normalizePathInput("./src/foo.ts")).toBe("./src/foo.ts");
	});

	it("leaves empty input unchanged", () => {
		expect(normalizePathInput("")).toBe("");
	});

	it("leaves Windows drive paths unchanged on every platform", () => {
		// `C:\foo` and `C:/foo` do not match Git-Bash or WSL patterns, so
		// they pass through verbatim regardless of host platform.
		expect(normalizePathInput("C:\\Users\\foo")).toBe("C:\\Users\\foo");
		expect(normalizePathInput("C:/Users/foo")).toBe("C:/Users/foo");
	});

	it("translates Git-Bash /c/foo to C:\\foo on Windows, no-op elsewhere", () => {
		if (process.platform === "win32") {
			expect(normalizePathInput("/c/Users/foo")).toBe("C:\\Users\\foo");
			expect(normalizePathInput("/C/Users/foo")).toBe("C:\\Users\\foo");
			expect(normalizePathInput("/d/proj/src/bar.ts")).toBe("D:\\proj\\src\\bar.ts");
		} else {
			expect(normalizePathInput("/c/Users/foo")).toBe("/c/Users/foo");
		}
	});

	it("translates WSL /mnt/c/foo to C:\\foo on Windows, no-op elsewhere", () => {
		if (process.platform === "win32") {
			expect(normalizePathInput("/mnt/c/Users/foo")).toBe("C:\\Users\\foo");
			expect(normalizePathInput("/mnt/C/proj")).toBe("C:\\proj");
		} else {
			expect(normalizePathInput("/mnt/c/Users/foo")).toBe("/mnt/c/Users/foo");
		}
	});

	it("does not touch POSIX absolute paths that are not Git-Bash/WSL style", () => {
		// `/home/user/proj` does not match `/<drive>/` or `/mnt/<drive>/` --
		// leave as-is. On Windows such a path is invalid, but normalizePathInput
		// only does format translation; existence is validated downstream.
		expect(normalizePathInput("/home/user/proj")).toBe("/home/user/proj");
	});
});

// Direct platform-parameterized tests so the Git-Bash/WSL translation logic
// is exercised on every CI platform, not just Windows runners.
describe("normalizePathInputForPlatform", () => {
	it("translates Git-Bash paths when platform is win32", () => {
		expect(normalizePathInputForPlatform("/c/Users/foo", "win32")).toBe("C:\\Users\\foo");
		expect(normalizePathInputForPlatform("/C/Users/foo", "win32")).toBe("C:\\Users\\foo");
		expect(normalizePathInputForPlatform("/d/proj/src", "win32")).toBe("D:\\proj\\src");
	});

	it("translates WSL paths when platform is win32", () => {
		expect(normalizePathInputForPlatform("/mnt/c/Users/foo", "win32")).toBe("C:\\Users\\foo");
		expect(normalizePathInputForPlatform("/mnt/C/proj", "win32")).toBe("C:\\proj");
	});

	it("is a no-op on non-win32 platforms", () => {
		expect(normalizePathInputForPlatform("/c/Users/foo", "linux")).toBe("/c/Users/foo");
		expect(normalizePathInputForPlatform("/mnt/c/Users/foo", "linux")).toBe("/mnt/c/Users/foo");
		expect(normalizePathInputForPlatform("/home/user/proj", "darwin")).toBe("/home/user/proj");
	});

	it("leaves Windows drive paths unchanged even on win32", () => {
		expect(normalizePathInputForPlatform("C:\\Users\\foo", "win32")).toBe("C:\\Users\\foo");
		expect(normalizePathInputForPlatform("C:/Users/foo", "win32")).toBe("C:/Users/foo");
	});

	it("leaves relative paths unchanged on every platform", () => {
		expect(normalizePathInputForPlatform("src/foo.ts", "win32")).toBe("src/foo.ts");
		expect(normalizePathInputForPlatform("src/foo.ts", "linux")).toBe("src/foo.ts");
	});

	it("handles bare drive root /c/ and /mnt/c/ as C:\\", () => {
		expect(normalizePathInputForPlatform("/c/", "win32")).toBe("C:\\");
		expect(normalizePathInputForPlatform("/mnt/c/", "win32")).toBe("C:\\");
	});

	it("does not misinterpret /home/ as a Git-Bash drive", () => {
		// `/home/user/proj` must NOT match the `/h/...` Git-Bash pattern
		// because the second segment is `home`, not a single drive letter.
		// The regex requires the first segment to be exactly one letter.
		expect(normalizePathInputForPlatform("/home/user/proj", "win32")).toBe("/home/user/proj");
	});

	it("does not misinterpret /usr/ as a Git-Bash drive", () => {
		expect(normalizePathInputForPlatform("/usr/local/bin", "win32")).toBe("/usr/local/bin");
	});
});

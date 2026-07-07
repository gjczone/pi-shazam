/**
 * Tests for issue #661: the path-traversal validation gate must not default
 * to process.cwd(). It now defaults to getEffectiveRoot() so a missing
 * projectRoot argument is never silently checked against the launch directory.
 */
import { describe, it, expect, vi } from "vitest";

const mockGetEffectiveRoot = vi.hoisted(() => vi.fn(() => process.cwd()));

vi.mock("../core/scanner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/scanner.js")>();
	return {
		...actual,
		getEffectiveRoot: mockGetEffectiveRoot,
	};
});

import { validatePathInProjectCore } from "../core/path-utils.js";

describe("issue #661: validation gate defaults to effective root, not cwd", () => {
	it("consults getEffectiveRoot() when no projectRoot is supplied", () => {
		mockGetEffectiveRoot.mockReturnValue(process.cwd());
		// A real file under the (mocked) effective root must validate true.
		const inside = validatePathInProjectCore("package.json");
		expect(inside).toBe(true);
		// The default must come from getEffectiveRoot, not process.cwd().
		expect(mockGetEffectiveRoot).toHaveBeenCalled();
	});

	it("rejects traversal outside the effective root", () => {
		mockGetEffectiveRoot.mockReturnValue(process.cwd());
		expect(validatePathInProjectCore("../../etc/passwd")).toBe(false);
	});

	it("still honors an explicit projectRoot argument for a real file", () => {
		const root = process.cwd();
		expect(validatePathInProjectCore("package.json", root)).toBe(true);
	});
});

/**
 * Tests for core/filter — isTrackableEditedPath.
 *
 * Verifies that pre-edit guard does not track writes to non-project paths
 * like /tmp, ~/.pi, node_modules, dist, .git, .venv, etc.
 */
import { describe, it, expect } from "vitest";
import { isTrackableEditedPath } from "../core/filter.js";

describe("core/filter isTrackableEditedPath", () => {
	it("should track regular project source files", () => {
		expect(isTrackableEditedPath("/project/src/foo.ts")).toBe(true);
		expect(isTrackableEditedPath("/project/hooks/safety.ts")).toBe(true);
		expect(isTrackableEditedPath("/project/core/filter.ts")).toBe(true);
	});

	it("should NOT track /tmp/ paths", () => {
		expect(isTrackableEditedPath("/tmp/foo.json")).toBe(false);
		expect(isTrackableEditedPath("/tmp/test.ts")).toBe(false);
	});

	it("should NOT track paths inside SKIP_DIRS (node_modules, dist, .git, .venv, coverage, .next)", () => {
		expect(isTrackableEditedPath("/project/node_modules/pkg/index.ts")).toBe(false);
		expect(isTrackableEditedPath("/project/dist/index.js")).toBe(false);
		expect(isTrackableEditedPath("/project/.git/config")).toBe(false);
		expect(isTrackableEditedPath("/project/.venv/lib/foo.py")).toBe(false);
		expect(isTrackableEditedPath("/project/coverage/lcov.info")).toBe(false);
		expect(isTrackableEditedPath("/project/.next/server/pages.js")).toBe(false);
	});

	it("should NOT track paths inside dot-directories not in SKIP_DIRS (e.g. .pi, .cache-custom)", () => {
		expect(isTrackableEditedPath("/home/user/.pi/hooks/state.json")).toBe(false);
		expect(isTrackableEditedPath("/project/.foo/bar.ts")).toBe(false);
	});

	it("should NOT track JSON files (package.json, tsconfig.json)", () => {
		expect(isTrackableEditedPath("/project/package.json")).toBe(false);
		expect(isTrackableEditedPath("/project/tsconfig.json")).toBe(false);
	});

	it("should track test files and markdown (they are editable source)", () => {
		expect(isTrackableEditedPath("/project/tests/foo.test.ts")).toBe(true);
		expect(isTrackableEditedPath("/project/README.md")).toBe(true);
	});
});

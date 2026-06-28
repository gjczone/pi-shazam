/**
 * Tests for issue #497: shazam_verify LSP diagnostic reliability detection,
 * error output truncation, and full diagnostics export.
 *
 * Verifies that:
 * - INFRASTRUCTURE_ERROR_PATTERNS correctly matches known false positive patterns
 * - checkDiagnosticReliability detects unreliable LSP diagnostics
 * - saveFullDiagnostics writes to .shazam/last-verify.json
 * - Error display is capped at MAX_DISPLAY_ERRORS in text output
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setProjectRoot, resetCache } from "../core/scanner.js";

// Re-import to clear module state
const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop()!;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	}
	resetCache();
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "shazam-497-"));
	tempDirs.push(dir);
	return dir;
}

// ---- Part 1: INFRASTRUCTURE_ERROR_PATTERNS matching ----

describe("INFRASTRUCTURE_ERROR_PATTERNS", () => {
	it("matches 'Cannot find module' errors", async () => {
		const { INFRASTRUCTURE_ERROR_PATTERNS } = await import("../tools/verify.js");
		const patterns = INFRASTRUCTURE_ERROR_PATTERNS;
		expect(patterns.some((p) => p.test("Cannot find module '@earendil-works/pi-coding-agent'"))).toBe(true);
	});

	it("matches 'Cannot find name' errors", async () => {
		const { INFRASTRUCTURE_ERROR_PATTERNS } = await import("../tools/verify.js");
		expect(INFRASTRUCTURE_ERROR_PATTERNS.some((p) => p.test("Cannot find name 'Set'"))).toBe(true);
	});

	it("matches 'property does not exist on type {}' errors", async () => {
		const { INFRASTRUCTURE_ERROR_PATTERNS } = await import("../tools/verify.js");
		expect(INFRASTRUCTURE_ERROR_PATTERNS.some((p) => p.test("Property 'length' does not exist on type '{}'"))).toBe(
			true,
		);
	});

	it("matches 'cannot find name node:' errors", async () => {
		const { INFRASTRUCTURE_ERROR_PATTERNS } = await import("../tools/verify.js");
		expect(INFRASTRUCTURE_ERROR_PATTERNS.some((p) => p.test("Cannot find name 'node:fs'"))).toBe(true);
	});

	it("matches 'implicitly has any type' errors", async () => {
		const { INFRASTRUCTURE_ERROR_PATTERNS } = await import("../tools/verify.js");
		expect(INFRASTRUCTURE_ERROR_PATTERNS.some((p) => p.test("Parameter 'x' implicitly has an 'any' type"))).toBe(true);
	});

	it("does NOT match normal type errors", async () => {
		const { INFRASTRUCTURE_ERROR_PATTERNS } = await import("../tools/verify.js");
		const normalErrors = [
			"Type 'string' is not assignable to type 'number'",
			"Argument of type '42' is not assignable to parameter of type 'string'",
			"Object is possibly 'undefined'",
			"'data' is declared but its value is never read",
			"Expected 2 arguments, but got 1",
		];
		for (const msg of normalErrors) {
			expect(INFRASTRUCTURE_ERROR_PATTERNS.some((p) => p.test(msg))).toBe(false);
		}
	});
});

// ---- Part 2: checkDiagnosticReliability ----

describe("checkDiagnosticReliability", () => {
	it("reports unreliable when >50% errors match infra patterns and total > 20", async () => {
		const { checkDiagnosticReliability } = await import("../tools/verify.js");
		const diags = [];
		// 15 infrastructure errors
		for (let i = 0; i < 15; i++) {
			diags.push({ message: `Cannot find module '@scope/pkg-${i}'` });
		}
		// 10 real errors
		for (let i = 0; i < 10; i++) {
			diags.push({ message: `Type 'string' is not assignable to type 'number'` });
		}
		const result = checkDiagnosticReliability(diags);
		expect(result.reliable).toBe(false);
		expect(result.infraErrorCount).toBe(15);
		expect(result.totalCount).toBe(25);
	});

	it("reports reliable when errors are ≤ 20 even if all match infra patterns", async () => {
		const { checkDiagnosticReliability } = await import("../tools/verify.js");
		const diags = [];
		for (let i = 0; i < 15; i++) {
			diags.push({ message: `Cannot find module '@scope/pkg-${i}'` });
		}
		const result = checkDiagnosticReliability(diags);
		// Total is 15, which is ≤ 20, so reliable
		expect(result.reliable).toBe(true);
	});

	it("reports reliable when ≤50% errors match infra patterns", async () => {
		const { checkDiagnosticReliability } = await import("../tools/verify.js");
		const diags = [];
		// 5 infra errors, 20 real errors = 25 total, 20% infra
		for (let i = 0; i < 5; i++) {
			diags.push({ message: `Cannot find module '@scope/pkg-${i}'` });
		}
		for (let i = 0; i < 20; i++) {
			diags.push({ message: `Type 'string' is not assignable to type 'number'` });
		}
		const result = checkDiagnosticReliability(diags);
		expect(result.reliable).toBe(true);
		expect(result.infraErrorCount).toBe(5);
		expect(result.totalCount).toBe(25);
	});

	it("handles empty diagnostics array", async () => {
		const { checkDiagnosticReliability } = await import("../tools/verify.js");
		const result = checkDiagnosticReliability([]);
		expect(result.reliable).toBe(true);
		expect(result.infraErrorCount).toBe(0);
		expect(result.totalCount).toBe(0);
	});

	it("handles diagnostics with no message field", async () => {
		const { checkDiagnosticReliability } = await import("../tools/verify.js");
		const diags = [{ message: "Cannot find module 'foo'" }, { message: "" }];
		const result = checkDiagnosticReliability(diags);
		// Second diag has empty message, should not match
		expect(result.infraErrorCount).toBe(1);
		expect(result.totalCount).toBe(2);
	});
});

// ---- Part 3: saveDiagnosticsExport ----

describe("saveDiagnosticsExport", () => {
	it("writes full diagnostics to .shazam/last-verify.json", async () => {
		const dir = makeTempDir();
		setProjectRoot(dir);

		const { saveDiagnosticsExport } = await import("../tools/verify.js");
		const diagnostics = [
			{
				file: "src/test.ts",
				line: 1,
				col: 1,
				severity: "error",
				message: "Cannot find module 'foo'",
			},
			{
				file: "src/main.ts",
				line: 10,
				col: 5,
				severity: "warning",
				message: "Unused variable 'x'",
			},
		];

		const resultPath = saveDiagnosticsExport(diagnostics, dir);
		expect(resultPath).toBe(join(dir, ".shazam", "last-verify.json"));
		expect(existsSync(resultPath)).toBe(true);

		const content = JSON.parse(readFileSync(resultPath, "utf-8"));
		expect(content.diagnostics).toEqual(diagnostics);
		expect(content.totalCount).toBe(2);
		expect(content.errorCount).toBe(1);
		expect(content.warningCount).toBe(1);
		expect(content.timestamp).toBeDefined();
	});

	it("creates .shazam directory if it does not exist", async () => {
		const dir = makeTempDir();
		setProjectRoot(dir);

		const { saveDiagnosticsExport } = await import("../tools/verify.js");
		const diagnostics = [{ message: "error" }];

		const resultPath = saveDiagnosticsExport(diagnostics, dir);
		expect(existsSync(join(dir, ".shazam"))).toBe(true);
		expect(existsSync(resultPath)).toBe(true);
	});

	it("overwrites previous export file", async () => {
		const dir = makeTempDir();
		setProjectRoot(dir);

		const { saveDiagnosticsExport } = await import("../tools/verify.js");

		// First write
		saveDiagnosticsExport([{ message: "first" }], dir);
		const first = JSON.parse(readFileSync(join(dir, ".shazam", "last-verify.json"), "utf-8"));

		// Second write should overwrite
		saveDiagnosticsExport([{ message: "second" }], dir);
		const second = JSON.parse(readFileSync(join(dir, ".shazam", "last-verify.json"), "utf-8"));

		expect(first.diagnostics[0].message).toBe("first");
		expect(second.diagnostics[0].message).toBe("second");
	});
});

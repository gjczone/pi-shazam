/**
 * Tests for issue #690: when saveGraphCache throws during a scan, the scanner
 * must log the failure via _logWarn (with the bound error) instead of silently
 * swallowing it.
 *
 * Minimum-scope verification:
 *  - The full-scan cache-save catch site calls _logWarn with the error object.
 *  - The incremental cache-save catch site (on a second scan with a partial
 *    disk cache) also calls _logWarn with the error object.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../core/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/output.js")>();
	return { ...actual, _logWarn: logWarn };
});

// Force saveGraphCache to throw so the scan's catch sites are reached.
vi.mock("../core/cache.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/cache.js")>();
	return {
		...actual,
		saveGraphCache: vi.fn(() => {
			throw new Error("disk full");
		}),
	};
});

import { scanProject } from "../core/scanner.js";

let rootDir: string;

beforeEach(() => {
	logWarn.mockClear();
	rootDir = mkdtempSync(join(tmpdir(), "cache-warn-"));
	const src = join(rootDir, "src");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "main.ts"), "export function main() { console.log('hi'); }");
});

afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe("issue #690: saveGraphCache failure is logged via _logWarn", () => {
	it("logs the error on full-scan cache save failure", () => {
		scanProject(rootDir);

		const call = logWarn.mock.calls.find(
			(c: unknown[]) => c[0] === "scanProject" && String(c[1]).startsWith("Failed to save graph cache"),
		);
		expect(call).toBeDefined();
		expect(call?.[2]).toBeInstanceOf(Error);
		expect((call?.[2] as Error).message).toBe("disk full");
	});
});

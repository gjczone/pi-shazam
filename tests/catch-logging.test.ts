/**
 * Regression tests for issue #553 (logging gaps in catch blocks) and the
 * project rule (AGENTS.md "Quality Gates": every catch branch MUST either
 * handle the error with a log or propagate it -- empty catch blocks are
 * forbidden).
 *
 * Two complementary guards:
 *  1. Behavioral -- trigger one modified catch site (detectFormatters on a
 *     malformed package.json) and assert the bound error object reaches
 *     _logWarn as its 3rd argument. Before the fix, the optional-catch-
 *     binding `catch { _logWarn(tag, msg) }` discarded the error, so the
 *     internal log recorded only a generic string with no root cause.
 *  2. Static grep gate -- no bare `catch {` (no error binding) remains in
 *     core/ tools/ hooks/ lsp/ mcp/. Both "truly empty" catches and
 *     "optional-catch-binding that discards the error" share this surface;
 *     the fix converts every `catch {` into `catch (err) {`, so zero
 *     matches is the comprehensive gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, extname } from "node:path";

// Capture _logWarn calls without touching the real audit log. Mock is hoisted
// before the imports below resolve, so core/formatters.ts receives the stub.
const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../core/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/output.js")>();
	return {
		...actual,
		_logWarn: logWarn,
		// Stub the file-backed sinks so the test never writes audit entries.
		writeJsonl: vi.fn(),
		_logInternal: vi.fn(),
	};
});

import { detectFormatters } from "../core/formatters.js";
import { lspWorkspaceSearch, type LspEnrichContext } from "../tools/lsp_enrich.js";

const ROOT = join(import.meta.dirname, "..");
const SCAN_DIRS = ["core", "tools", "hooks", "lsp", "mcp"];

function collectTsFiles(dir: string, out: string[] = []): string[] {
	const abs = join(ROOT, dir);
	let entries: Dirent[];
	try {
		entries = readdirSync(abs, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name === "dist") continue;
			collectTsFiles(join(dir, e.name), out);
		} else if (e.isFile() && extname(e.name) === ".ts") {
			out.push(join(abs, e.name));
		}
	}
	return out;
}

describe("issue #553: catch sites bind and log the error cause", () => {
	beforeEach(() => {
		logWarn.mockClear();
	});

	it("detectFormatters passes the JSON parse error to _logWarn", () => {
		const dir = mkdtempSync(join(tmpdir(), "shazam-catch-"));
		try {
			// Malformed package.json triggers the detectFormatters catch site.
			writeFileSync(join(dir, "package.json"), "{ this is not valid json");
			detectFormatters(dir);

			const call = logWarn.mock.calls.find(
				(c: unknown[]) => c[0] === "detectFormatters" && c[1] === "package.json parse failed",
			);
			// The catch site exists and was reached.
			expect(call).toBeDefined();
			// The 3rd argument is the bound error object -- the core of the fix.
			expect(call?.[2]).toBeInstanceOf(Error);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("issue #553: no bare `catch {` remains in source", () => {
	it("core/tools/hooks/lsp/mcp have zero `catch {` (no error binding)", () => {
		const files = SCAN_DIRS.flatMap((d) => collectTsFiles(d));
		const offending: string[] = [];
		for (const f of files) {
			const src = readFileSync(f, "utf-8");
			// Match a `catch` keyword not followed by a binding paren -- i.e.
			// `catch {` or `catch{`. `catch (err) {` and `.catch(() => {` do
			// not match (the former has `(` after catch; the latter is a
			// method call whose `catch` is followed by `(`).
			const matches = src.match(/\bcatch\s*\{/g) ?? [];
			if (matches.length > 0) {
				offending.push(`${relative(ROOT, f)}: ${matches.length}`);
			}
		}
		expect(offending).toEqual([]);
	});
});

describe("issue #550: withEnrichTimeout logs rejection cause instead of swallowing", () => {
	beforeEach(() => {
		logWarn.mockClear();
	});

	it("logs when the LSP enrich request rejects before timeout", async () => {
		const rejectionErr = new Error("LSP connection lost");
		const mockClient = {
			isRunning: () => true,
			serverCapabilities: { workspaceSymbolProvider: true },
			workspaceSymbol: vi.fn().mockRejectedValue(rejectionErr),
		};
		const ctx: LspEnrichContext = {
			getServerForFile: async () => null,
			getActiveServers: () => [{ language: "typescript", client: mockClient as never, workspaceRoot: "/ws" }],
			trackOpenedFile: () => {},
		};
		const results = await lspWorkspaceSearch(ctx, "foo", 1000);
		expect(results).toEqual([]);
		const call = logWarn.mock.calls.find((c: unknown[]) => c[0] === "withEnrichTimeout" && typeof c[1] === "string");
		expect(call).toBeDefined();
		expect(call?.[2]).toBe(rejectionErr);
	});

	it("logs late rejection that fires after the timeout already resolved", async () => {
		const lateErr = new Error("LSP server crashed mid-request");
		const mockClient = {
			isRunning: () => true,
			serverCapabilities: { workspaceSymbolProvider: true },
			workspaceSymbol: vi
				.fn()
				.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(lateErr), 100))),
		};
		const ctx: LspEnrichContext = {
			getServerForFile: async () => null,
			getActiveServers: () => [{ language: "typescript", client: mockClient as never, workspaceRoot: "/ws" }],
			trackOpenedFile: () => {},
		};
		// 30 ms timeout: the timeout fires first, then the 100 ms rejection
		// triggers the late-rejection handler.
		const results = await lspWorkspaceSearch(ctx, "foo", 30);
		expect(results).toEqual([]);
		// Wait for the late rejection to fire and be logged.
		await new Promise((r) => setTimeout(r, 200));
		const lateCall = logWarn.mock.calls.find(
			(c: unknown[]) => c[0] === "withEnrichTimeout" && c[1] === "LSP enrich late rejection after timeout",
		);
		expect(lateCall).toBeDefined();
		expect(lateCall?.[2]).toBe(lateErr);
	});
});

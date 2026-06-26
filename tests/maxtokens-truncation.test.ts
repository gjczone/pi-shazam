/**
 * Tests for issue #470: customExecute tools (format/rename_symbol) and
 * verify JSON mode silently drop maxTokens truncation.
 *
 * Verifies that:
 * - shazam_format honors maxTokens in text mode (truncates large output)
 * - shazam_rename_symbol honors maxTokens in text mode
 * - shazam_verify --json honors maxTokens (caps lspDiagnostics)
 * - JSON mode is NOT truncated for format/rename_symbol (preserves valid JSON)
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ToolDefinition } from "../types/pi-extension.js";
import { setProjectRoot, resetCache } from "../core/scanner.js";
import { registerFormat } from "../tools/format.js";
import { registerRenameSymbol } from "../tools/rename_symbol.js";
import { registerVerify, capVerifyDiagnostics } from "../tools/verify.js";

/**
 * Create a mock ExtensionAPI that captures the registered tool definition.
 */
function mockPi(): { pi: ExtensionAPI; registered: ToolDefinition[] } {
	const registered: ToolDefinition[] = [];
	const pi = {
		registerTool: (t: ToolDefinition) => registered.push(t),
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

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
	const dir = mkdtempSync(join(tmpdir(), "shazam-470-"));
	tempDirs.push(dir);
	return dir;
}

// ── shazam_format ─────────────────────────────────────────────────────────

describe("Issue #470: shazam_format honors maxTokens", () => {
	it("truncates large format output when maxTokens is set (text mode)", async () => {
		const dir = makeTempDir();
		mkdirSync(join(dir, "src"), { recursive: true });
		// Create 30 files with trailing whitespace to produce many format issues
		for (let i = 0; i < 30; i++) {
			writeFileSync(
				join(dir, "src", `mod_${i}.ts`),
				`export function f${i}() {\n  return 1;   \n}\n`,
			);
		}
		setProjectRoot(dir);

		const { pi, registered } = mockPi();
		registerFormat(pi);
		const tool = registered[0]!;

		const resultCapped = await tool.execute("c1", { maxTokens: 20 }, undefined, undefined, {} as never);
		const resultFull = await tool.execute("c2", {}, undefined, undefined, {} as never);

		const textCapped = (resultCapped.content[0] as { text: string }).text;
		const textFull = (resultFull.content[0] as { text: string }).text;

		// Truncated output must be shorter than the full output
		expect(textCapped.length).toBeLessThan(textFull.length);
		// Truncation marker must be present
		expect(textCapped).toContain("truncated");
	});

	it("does not truncate JSON mode (preserves valid JSON even with maxTokens)", async () => {
		const dir = makeTempDir();
		mkdirSync(join(dir, "src"), { recursive: true });
		for (let i = 0; i < 10; i++) {
			writeFileSync(
				join(dir, "src", `mod_${i}.ts`),
				`export function f${i}() {\n  return 1;   \n}\n`,
			);
		}
		setProjectRoot(dir);

		const { pi, registered } = mockPi();
		registerFormat(pi);
		const tool = registered[0]!;

		const result = await tool.execute(
			"c3",
			{ json: true, maxTokens: 10 },
			undefined,
			undefined,
			{} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		// JSON mode must produce valid JSON even with maxTokens set
		expect(() => JSON.parse(text)).not.toThrow();
	});
});

// ── shazam_rename_symbol ──────────────────────────────────────────────────

describe("Issue #470: shazam_rename_symbol honors maxTokens", () => {
	it("truncates large rename output when maxTokens is set (text mode)", async () => {
		const dir = makeTempDir();
		mkdirSync(join(dir, "src"), { recursive: true });
		// Target symbol that many callers reference
		writeFileSync(
			join(dir, "src", "target.ts"),
			"export function myTarget() {\n  return 1;\n}\n",
		);
		// 30 callers -- produces 30 incoming references (formatGraphRefs caps at 20)
		for (let i = 0; i < 30; i++) {
			writeFileSync(
				join(dir, "src", `caller_${i}.ts`),
				`import { myTarget } from "./target";\nexport function caller${i}() {\n  return myTarget();\n}\n`,
			);
		}
		setProjectRoot(dir);

		const { pi, registered } = mockPi();
		registerRenameSymbol(pi);
		const tool = registered[0]!;

		// dryRun=true avoids the call_chain gate; LSP unavailable in tests
		// so executeRenameSymbol returns lsp_unavailable with graph refs
		const resultCapped = await tool.execute(
			"c4",
			{ symbol: "myTarget", newName: "renamedTarget", dryRun: true, maxTokens: 10 },
			undefined,
			undefined,
			{} as never,
		);
		const resultFull = await tool.execute(
			"c5",
			{ symbol: "myTarget", newName: "renamedTarget", dryRun: true },
			undefined,
			undefined,
			{} as never,
		);

		const textCapped = (resultCapped.content[0] as { text: string }).text;
		const textFull = (resultFull.content[0] as { text: string }).text;

		// Truncated output must be shorter than the full output
		expect(textCapped.length).toBeLessThan(textFull.length);
		expect(textCapped).toContain("truncated");
	});
});

// ── shazam_verify JSON ────────────────────────────────────────────────────

describe("Issue #470: shazam_verify JSON caps lspDiagnostics", () => {
	it("caps lspDiagnostics when serialized output exceeds maxTokens", () => {
		const diags = Array.from({ length: 200 }, (_, i) => ({
			file: `src/mod_${i}.ts`,
			line: 1,
			col: 1,
			endLine: 1,
			endCol: 5,
			severity: "error",
			code: "TS1234",
			message: `Error number ${i} with a moderately long description to bloat the JSON`,
		}));
		const result: { lspDiagnostics: typeof diags; lspDiagnosticsTruncated?: number } = {
			lspDiagnostics: diags,
		};
		const text = JSON.stringify({ result });

		// maxTokens small enough to trigger truncation
		const truncated = capVerifyDiagnostics(result, text, 50);

		expect(truncated).toBe(true);
		expect(result.lspDiagnostics.length).toBe(100);
		expect(result.lspDiagnosticsTruncated).toBe(100);
	});

	it("does not cap when output fits within maxTokens", () => {
		const result: {
			lspDiagnostics: { file: string; line: number; col: number; endLine: number; endCol: number; severity: string; code: string; message: string }[];
			lspDiagnosticsTruncated?: number;
		} = {
			lspDiagnostics: [
				{ file: "a.ts", line: 1, col: 1, endLine: 1, endCol: 5, severity: "error", code: "TS1", message: "err" },
			],
		};
		const text = JSON.stringify({ result });

		const truncated = capVerifyDiagnostics(result, text, 1000);

		expect(truncated).toBe(false);
		expect(result.lspDiagnostics.length).toBe(1);
		expect(result.lspDiagnosticsTruncated).toBeUndefined();
	});

	it("does not cap when maxTokens is not set", () => {
		const diags = Array.from({ length: 200 }, (_, i) => ({
			file: `f${i}.ts`,
			line: 1,
			col: 1,
			endLine: 1,
			endCol: 5,
			severity: "error",
			code: "TS1",
			message: "e",
		}));
		const result: { lspDiagnostics: typeof diags; lspDiagnosticsTruncated?: number } = {
			lspDiagnostics: diags,
		};
		const text = JSON.stringify({ result });

		const truncated = capVerifyDiagnostics(result, text, undefined);

		expect(truncated).toBe(false);
		expect(result.lspDiagnostics.length).toBe(200);
	});

	it("does not cap when lspDiagnostics is already under the cap", () => {
		const diags = Array.from({ length: 50 }, (_, i) => ({
			file: `f${i}.ts`,
			line: 1,
			col: 1,
			endLine: 1,
			endCol: 5,
			severity: "error",
			code: "TS1",
			message: "e",
		}));
		const result: { lspDiagnostics: typeof diags; lspDiagnosticsTruncated?: number } = {
			lspDiagnostics: diags,
		};
		// Build a text that exceeds maxTokens but diagnostics are under cap
		const text = JSON.stringify({ result, padding: "x".repeat(1000) });

		const truncated = capVerifyDiagnostics(result, text, 10);

		// Under the cap -- no truncation even if text exceeds maxTokens
		expect(truncated).toBe(false);
		expect(result.lspDiagnostics.length).toBe(50);
		expect(result.lspDiagnosticsTruncated).toBeUndefined();
	});
});

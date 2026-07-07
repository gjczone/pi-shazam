/**
 * tests/github-action-entrypoint.test.ts
 *
 * Tests for `formatVerifyComment` (tools/verify-comment.ts) and
 * the post-comment wiring (`.github/actions/shazam-verify/post-comment.mjs`).
 *
 * #638: GitHub Action wrapper for shazam_verify — PR-time risk-scored review.
 */
import { describe, it, expect } from "vitest";
import { formatVerifyComment, type VerifyCommentInput } from "../tools/verify-comment.js";

// ── Minimal fixture builders ──────────────────────────────────────────────

function makeResult(overrides: Partial<VerifyCommentInput> = {}): VerifyCommentInput {
	return {
		schema_version: "1.0",
		command: "verify",
		project: "/workspace/example",
		status: "ok",
		result: {
			symbolCount: 2899,
			fileCount: 122,
			edgeCount: 1209,
			riskLevel: "high",
			riskReason: "2 errors, high-change PR",
			orphanCount: 3,
			internalOrphanCount: 2,
			exportedOrphanCount: 1,
			gitChangedFiles: ["src/foo.ts", "src/bar.ts"],
			baselineDiff: null,
			lspDiagnostics: [
				{
					file: "src/foo.ts",
					line: 42,
					col: 5,
					severity: "error",
					code: "TS2322",
					message: "Property 'x' is missing in type 'Foo'",
					source: "ts",
				},
				{
					file: "src/bar.ts",
					line: 18,
					col: 9,
					severity: "error",
					code: "TS2345",
					message: "Type 'string' is not assignable to 'number'",
					source: "ts",
				},
				{
					file: "src/baz.ts",
					line: 99,
					col: 1,
					severity: "error",
					code: "TS2304",
					message: "Cannot find name 'undefined_var'",
					source: "ts",
				},
				{
					file: "src/qux.ts",
					line: 10,
					col: 3,
					severity: "warning",
					code: "TS6133",
					message: "Variable 'unused' is declared but never used",
					source: "ts",
				},
				{
					file: "src/info.ts",
					line: 1,
					col: 1,
					severity: "info",
					code: "TS0",
					message: "info msg",
					source: "ts",
				},
			],
			lspAvailable: true,
			verdict: "FAIL",
			quickMode: false,
			lspOnlyMode: false,
			preCommitMode: false,
			...overrides.result,
		},
		...overrides,
	};
}

// ── formatVerifyComment ───────────────────────────────────────────────────

describe("formatVerifyComment", () => {
	it("renders a FAIL verdict with errors", () => {
		const input = makeResult();
		const md = formatVerifyComment(input);

		expect(md).toContain("**Verdict**: FAIL");
		expect(md).toContain("**Risk**: high");
		expect(md).toContain("**Errors**: 3");
		expect(md).toContain("**Warnings**: 1");
		expect(md).toContain("**Info**: 1");
		expect(md).toContain("**Edges**: 1209");
		expect(md).toContain("**Symbols**: 2899");
		expect(md).toContain("**Files**: 122");
	});

	it("renders Top N Errors section from diagnostics", () => {
		const input = makeResult();
		const md = formatVerifyComment(input);

		expect(md).toContain("### Top 3 Errors");
		expect(md).toContain("src/foo.ts:42:5");
		expect(md).toContain("Property 'x' is missing in type 'Foo'");
		expect(md).toContain("src/bar.ts:18:9");
		expect(md).toContain("src/baz.ts:99:1");
	});

	it("omits Top Errors section when no error diagnostics", () => {
		const input = makeResult({
			result: {
				...makeResult().result,
				lspDiagnostics: [
					{
						file: "src/a.ts",
						line: 1,
						col: 1,
						severity: "warning",
						code: "TS6133",
						message: "unused var",
						source: "ts",
					},
				],
				verdict: "PASS",
				riskLevel: "low",
				riskReason: "no issues",
			},
		});
		const md = formatVerifyComment(input);

		expect(md).toContain("**Verdict**: PASS");
		expect(md).not.toContain("### Top");
	});

	it("renders Changed Files section", () => {
		const input = makeResult();
		const md = formatVerifyComment(input);

		expect(md).toContain("### Changed Files");
		expect(md).toContain("- `src/foo.ts`");
		expect(md).toContain("- `src/bar.ts`");
	});

	it("omits Changed Files when gitChangedFiles is empty", () => {
		const input = makeResult({
			result: {
				...makeResult().result,
				gitChangedFiles: [],
			},
		});
		const md = formatVerifyComment(input);

		expect(md).not.toContain("### Changed Files");
	});

	it("renders Affected Critical Paths section when provided", () => {
		const input = makeResult({
			criticalPaths: [
				{ symbol: "scanProject", incomingCallers: 24 },
				{ symbol: "getGraph", incomingCallers: 2 },
				{ symbol: "runLspDiagnostics", incomingCallers: 0 },
			],
		});
		const md = formatVerifyComment(input);

		expect(md).toContain("### Affected Critical Paths");
		expect(md).toContain("- `scanProject` (top by PageRank) — 24 incoming callers");
		expect(md).toContain("- `getGraph` (mcp) — 2 incoming callers");
		expect(md).toContain("- `runLspDiagnostics` (verify) — internal-only");
	});

	it("omits Affected Critical Paths when not provided", () => {
		const input = makeResult();
		const md = formatVerifyComment(input);

		expect(md).not.toContain("### Affected Critical Paths");
	});

	it("renders Orphan summary", () => {
		const input = makeResult();
		const md = formatVerifyComment(input);

		expect(md).toContain("### Orphan Summary");
		expect(md).toContain("**Internal**: 2");
		expect(md).toContain("**Exported**: 1");
	});

	it("handles WARN verdict", () => {
		const input = makeResult({
			result: {
				...makeResult().result,
				lspDiagnostics: [],
				lspAvailable: false,
				verdict: "WARN",
				riskLevel: "medium",
				riskReason: "LSP unavailable",
			},
		});
		const md = formatVerifyComment(input);

		expect(md).toContain("**Verdict**: WARN");
		expect(md).toContain("**Risk**: medium");
	});

	it("caps top errors at 3 by default", () => {
		const diagnostics = Array.from({ length: 10 }, (_, i) => ({
			file: `src/file${i}.ts`,
			line: i + 1,
			col: 1,
			severity: "error" as const,
			code: `TS${i}`,
			message: `error ${i}`,
			source: "ts",
		}));
		const input = makeResult({
			result: {
				...makeResult().result,
				lspDiagnostics: diagnostics,
				verdict: "FAIL",
			},
		});
		const md = formatVerifyComment(input);

		expect(md).toContain("### Top 3 Errors");
		// Should show exactly 3 errors
		const errorLines = md.split("\n").filter((l) => l.startsWith("- [ERROR]"));
		expect(errorLines.length).toBe(3);
	});

	it("respects maxErrors parameter for top errors cap", () => {
		const diagnostics = Array.from({ length: 6 }, (_, i) => ({
			file: `src/file${i}.ts`,
			line: i + 1,
			col: 1,
			severity: "error" as const,
			code: `TS${i}`,
			message: `error ${i}`,
			source: "ts",
		}));
		const input = makeResult({
			result: {
				...makeResult().result,
				lspDiagnostics: diagnostics,
				verdict: "FAIL",
			},
		});
		const md = formatVerifyComment(input, { maxErrors: 5 });

		expect(md).toContain("### Top 5 Errors");
		const errorLines = md.split("\n").filter((l) => l.startsWith("- [ERROR]"));
		expect(errorLines.length).toBe(5);
	});

	it("renders header with pi-shazam branding", () => {
		const input = makeResult();
		const md = formatVerifyComment(input);

		expect(md).toContain("## shazam_verify — pi-shazam");
	});

	it("renders full report footer", () => {
		const input = makeResult();
		const md = formatVerifyComment(input);

		expect(md).toContain("Full report: artifact `shazam-verify-report` attached to this run");
	});

	it("handles empty diagnostics (all counts zero)", () => {
		const input = makeResult({
			result: {
				...makeResult().result,
				lspDiagnostics: [],
				lspAvailable: true,
				verdict: "PASS",
				riskLevel: "low",
				riskReason: "no issues found",
			},
		});
		const md = formatVerifyComment(input);

		expect(md).toContain("**Verdict**: PASS");
		expect(md).toContain("**Errors**: 0");
		expect(md).toContain("**Warnings**: 0");
		expect(md).toContain("**Info**: 0");
	});

	it("renders quick mode label", () => {
		const input = makeResult({
			result: {
				...makeResult().result,
				quickMode: true,
				lspDiagnostics: [],
				lspAvailable: false,
				verdict: "PASS",
				riskLevel: "low",
				riskReason: "quick mode",
			},
		});
		const md = formatVerifyComment(input);

		expect(md).toContain("(Quick)");
	});

	it("renders preCommit mode label", () => {
		const input = makeResult({
			result: {
				...makeResult().result,
				preCommitMode: true,
				lspDiagnostics: [],
				lspAvailable: false,
				verdict: "PASS",
				riskLevel: "low",
				riskReason: "pre-commit mode",
			},
		});
		const md = formatVerifyComment(input);

		expect(md).toContain("(Pre-Commit)");
	});

	it("renders lspOnly mode label", () => {
		const input = makeResult({
			result: {
				...makeResult().result,
				lspOnlyMode: true,
				lspDiagnostics: [],
				lspAvailable: true,
				verdict: "PASS",
				riskLevel: "low",
				riskReason: "lsp only mode",
			},
		});
		const md = formatVerifyComment(input);

		expect(md).toContain("(LSP Only)");
	});
});

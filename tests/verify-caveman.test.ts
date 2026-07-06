/**
 * Regression tests for issue #629 sub-task 2: `shazam_verify` text mode
 * is single-line per diagnostic (LLM-friendly "caveman" format).
 *
 * Before: each diagnostic rendered as 2-4 lines (header + suggestedFixes
 * indents + truncation message). Hundreds of diagnostics × 3-4 lines =
 * a lot of wasted tokens for an LLM that mostly wants to know "what broke".
 *
 * After: one line per diagnostic, summary header on top:
 *   `path:line:col  SEV CODE  message (source)`
 *   `3 errors, 5 warnings across 2 files. Build: clean.`
 *
 * The `MAX_DISPLAY_ERRORS` truncation + `.shazam/last-verify.json`
 * auto-export are dropped from the text path. JSON mode is unchanged --
 * it always carried the full structured diagnostic list.
 *
 * These tests target the exported `formatDiagnosticCompact` and
 * `summarizeDiagnostics` helpers directly so they don't need a live LSP
 * server.
 */
import { describe, it, expect } from "vitest";
import { formatDiagnosticCompact, summarizeDiagnostics } from "../tools/verify.js";

/** Synthetic diagnostic factory. Defaults to a TypeScript error. */
function diag(
	over: Partial<{
		file: string;
		line: number;
		col: number;
		severity: "error" | "warning" | "info" | "hint";
		code: string;
		message: string;
	}> = {},
) {
	return {
		file: over.file ?? "src/foo.ts",
		line: over.line ?? 42,
		col: over.col ?? 5,
		endLine: over.line ?? 42,
		endCol: (over.col ?? 5) + 1,
		severity: over.severity ?? "error",
		code: over.code ?? "TS2322",
		message: over.message ?? "Type 'string' is not assignable to type 'number'.",
	};
}

describe("issue #629 / 2: formatDiagnosticCompact", () => {
	it("renders a TypeScript error in the expected compact shape", () => {
		const line = formatDiagnosticCompact(diag());
		// Shape: path:line:col  SEV CODE  message (source)
		expect(line).toBe("src/foo.ts:42:5  ERR TS2322  Type 'string' is not assignable to type 'number'. (typescript)");
	});

	it("uses 3-letter severity codes ERR/WRN/INF/HNT", () => {
		expect(formatDiagnosticCompact(diag({ severity: "error" }))).toMatch(/\bERR\b/);
		expect(formatDiagnosticCompact(diag({ severity: "warning" }))).toMatch(/\bWRN\b/);
		expect(formatDiagnosticCompact(diag({ severity: "info" }))).toMatch(/\bINF\b/);
		expect(formatDiagnosticCompact(diag({ severity: "hint" }))).toMatch(/\bHNT\b/);
	});

	it("omits the code slot when the diagnostic has no code", () => {
		const line = formatDiagnosticCompact(diag({ code: "" }));
		// When code is empty the SEV label must be followed directly by the
		// message -- no diagnostic code word in between. The line still has
		// the canonical `SEV  message` two-space separator.
		expect(line).toMatch(/ERR\s+Type /);
		// And no code-word (TS1234, etc.) between ERR and the message text.
		expect(line).not.toMatch(/ERR\s+TS\d+\s+/);
	});

	it("infers the source label from file extension", () => {
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.ts" }))).toContain("(typescript)");
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.tsx" }))).toContain("(typescript)");
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.js" }))).toContain("(javascript)");
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.py" }))).toContain("(python)");
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.go" }))).toContain("(go)");
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.rs" }))).toContain("(rust)");
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.dart" }))).toContain("(dart)");
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.json" }))).toContain("(json)");
		expect(formatDiagnosticCompact(diag({ file: "lib/bar.unknown" }))).toContain("(unknown)");
	});

	it("produces a single-line output (no embedded newlines)", () => {
		const line = formatDiagnosticCompact(diag());
		expect(line.split("\n").length).toBe(1);
	});

	it("matches the issue-spec regex shape", () => {
		// Spec (issue #629): `path:line:col  SEV CODE  message. (source)`
		const line = formatDiagnosticCompact(diag());
		expect(line).toMatch(/^[\w./-]+:\d+:\d+\s+(ERR|WRN|INF|HNT)\s+\S*\s+.+ \(.+\)$/);
	});

	it("does not render suggestedFixes (LLM should use --json for that)", () => {
		// Even if a diagnostic carries suggestedFixes, the compact line
		// must not embed them -- that was the point of #629.
		const d = diag();
		(d as { suggestedFixes?: string[] }).suggestedFixes = ["Fix: use Number(x)"];
		const line = formatDiagnosticCompact(d);
		expect(line).not.toContain("Fix:");
		expect(line.split("\n").length).toBe(1);
	});
});

describe("issue #629 / 2: summarizeDiagnostics", () => {
	it("produces the `N errors, M warnings across K files. Build: clean.` line", () => {
		const diagnostics = [
			diag({ file: "src/a.ts", severity: "error" }),
			diag({ file: "src/a.ts", severity: "error" }),
			diag({ file: "src/a.ts", severity: "error" }),
			diag({ file: "src/b.ts", severity: "warning" }),
			diag({ file: "src/b.ts", severity: "warning" }),
			diag({ file: "src/b.ts", severity: "warning" }),
			diag({ file: "src/b.ts", severity: "warning" }),
			diag({ file: "src/b.ts", severity: "warning" }),
		];
		expect(summarizeDiagnostics(diagnostics)).toBe("3 errors, 5 warnings across 2 files. Build: clean.");
	});

	it("uses singular `file` when there is exactly one affected file", () => {
		const diagnostics = [diag({ file: "src/a.ts", severity: "error" })];
		expect(summarizeDiagnostics(diagnostics)).toBe("1 errors, 0 warnings across 1 file. Build: clean.");
	});

	it("returns the canonical empty-build message when diagnostics is empty", () => {
		// Issue spec example shows `3 errors, 5 warnings across 2 files.`
		// For an empty set we still emit the same shape so consumers can
		// parse it uniformly (the spec text says `Build: clean.` always).
		expect(summarizeDiagnostics([])).toBe("0 errors, 0 warnings across 0 files. Build: clean.");
	});

	it("counts info and hint severities as neither error nor warning", () => {
		const diagnostics = [diag({ file: "src/a.ts", severity: "info" }), diag({ file: "src/a.ts", severity: "hint" })];
		expect(summarizeDiagnostics(diagnostics)).toBe("0 errors, 0 warnings across 1 file. Build: clean.");
	});
});

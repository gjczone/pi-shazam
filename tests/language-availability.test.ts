/**
 * Tests for language availability awareness (follow-up to #349).
 *
 * Key design: warnings are CONTEXTUAL — only shown for languages
 * the project actually uses. A pure TypeScript project never sees
 * Dart warnings, preventing noise from irrelevant unavailable parsers.
 */
import { describe, it, expect } from "vitest";
import { getParserStatus, getProjectParserWarnings, EXT_TO_LANG, TreeSitterAdapter } from "../core/treesitter.js";
import { generateOverviewForPrompt, resetOverviewShown } from "../hooks/before-start.js";
import { executeOverview } from "../tools/overview.js";
import { scanProject } from "../core/scanner.js";

// Ensure parsers are loaded before tests run
const _adapter = new TreeSitterAdapter();

describe("Language availability awareness", () => {
	describe("getParserStatus", () => {
		it("should return status for all registered languages", () => {
			const status = getParserStatus();
			const registeredLangs = new Set(Object.values(EXT_TO_LANG));
			for (const lang of registeredLangs) {
				expect(status.has(lang)).toBe(true);
			}
		});

		it("should report loaded status for working parsers", () => {
			const status = getParserStatus();
			expect(status.get("python")?.status).toBe("loaded");
			expect(status.get("javascript")?.status).toBe("loaded");
			expect(status.get("go")?.status).toBe("loaded");
			expect(status.get("json")?.status).toBe("loaded");
			expect(status.get("typescript")?.status).toBe("loaded");
		});

		it("should report Dart as unavailable (tree-sitter 0.22.4 incompat)", () => {
			const status = getParserStatus();
			const dartStatus = status.get("dart");
			expect(dartStatus).toBeDefined();
			expect(dartStatus?.status).toBe("unavailable");
			expect(dartStatus?.reason).toBeDefined();
			expect(dartStatus?.reason!.length).toBeGreaterThan(0);
		});

		it("should include suggestion for unavailable languages", () => {
			const status = getParserStatus();
			const hasUnavailable = [...status.values()].some((v) => v.status === "unavailable");
			if (!hasUnavailable) return;
			for (const [, info] of status) {
				if (info.status === "unavailable") {
					expect(info.suggestion).toBeDefined();
					expect(info.suggestion!.length).toBeGreaterThan(0);
				}
			}
		});
	});

	describe("getProjectParserWarnings (contextual filtering)", () => {
		it("should return empty for a pure TypeScript project (no Dart files)", () => {
			// pi-shazam is a TypeScript project — no .dart files
			const warnings = getProjectParserWarnings(["index.ts", "core/scanner.ts", "tools/overview.ts"]);
			// Dart is unavailable but the project has no .dart files → no warning
			const dartWarning = warnings.find(([lang]) => lang === "dart");
			expect(dartWarning).toBeUndefined();
		});

		it("should warn about Dart when project has .dart files", () => {
			const warnings = getProjectParserWarnings(["main.dart", "lib/app.dart", "pubspec.yaml"]);
			const dartStatus = getParserStatus().get("dart");
			if (dartStatus?.status === "unavailable") {
				const dartWarning = warnings.find(([lang]) => lang === "dart");
				expect(dartWarning).toBeDefined();
				expect(dartWarning![0]).toBe("dart");
			}
		});

		it("should warn about multiple unavailable languages if project uses them", () => {
			// Hypothetical: project with dart + rust + python files
			const warnings = getProjectParserWarnings(["main.dart", "lib.rs", "app.py"]);
			// Rust and Python parsers are loaded, so only Dart should warn
			const dartWarning = warnings.find(([lang]) => lang === "dart");
			const rustWarning = warnings.find(([lang]) => lang === "rust");
			const pythonWarning = warnings.find(([lang]) => lang === "python");
			const dartStatus = getParserStatus().get("dart");
			if (dartStatus?.status === "unavailable") {
				expect(dartWarning).toBeDefined();
			}
			expect(rustWarning).toBeUndefined(); // rust parser is loaded
			expect(pythonWarning).toBeUndefined(); // python parser is loaded
		});

		it("should return empty for empty file list", () => {
			const warnings = getProjectParserWarnings([]);
			expect(warnings.length).toBe(0);
		});

		it("should return empty for files with unrecognized extensions", () => {
			const warnings = getProjectParserWarnings(["README.md", "Makefile", "Dockerfile"]);
			expect(warnings.length).toBe(0);
		});
	});

	describe("overview output (contextual)", () => {
		it("should NOT include Dart warning for this TypeScript project", () => {
			// pi-shazam is pure TypeScript — no .dart files
			const graph = scanProject(".");
			const output = executeOverview(graph, ".");
			// Dart is unavailable but should NOT appear in warnings
			// because there are no .dart files in pi-shazam
			expect(output).not.toContain("Parser Availability Warning");
		});
	});

	describe("before-start hook (contextual)", () => {
		it("should NOT inject Dart warning for this TypeScript project", () => {
			resetOverviewShown();
			const result = generateOverviewForPrompt(".");
			// Should NOT mention dart parser status for a TS-only project
			expect(result).not.toContain("Language Parser Status");
		});
	});
});

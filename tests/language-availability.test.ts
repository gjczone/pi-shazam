/**
 * Tests for language availability awareness (follow-up to #349).
 *
 * When a tree-sitter grammar fails to load (e.g. Dart with tree-sitter 0.22.4),
 * the LLM must be informed which languages are unavailable and why.
 * This prevents "silent failures" where tools return empty results for valid files.
 */
import { describe, it, expect } from "vitest";
import { getParserStatus, EXT_TO_LANG, TreeSitterAdapter } from "../core/treesitter.js";
import { generateOverviewForPrompt, resetOverviewShown } from "../hooks/before-start.js";
import { executeOverview } from "../tools/overview.js";
import { scanProject } from "../core/scanner.js";

// Ensure parsers are loaded before tests run
const _adapter = new TreeSitterAdapter();

describe("Language availability awareness", () => {
	describe("getParserStatus", () => {
		it("should return status for all registered languages", () => {
			const status = getParserStatus();
			// Every language in EXT_TO_LANG should appear in the status
			const registeredLangs = new Set(Object.values(EXT_TO_LANG));
			for (const lang of registeredLangs) {
				expect(status.has(lang)).toBe(true);
			}
		});

		it("should report loaded status for working parsers", () => {
			const status = getParserStatus();
			// These languages should always be loaded
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
			// Dart grammar requires tree-sitter >=0.24, fails on 0.22.4
			expect(dartStatus?.status).toBe("unavailable");
			expect(dartStatus?.reason).toBeDefined();
			expect(dartStatus?.reason!.length).toBeGreaterThan(0);
		});

		it("should include suggestion for unavailable languages", () => {
			const status = getParserStatus();
			const hasUnavailable = [...status.values()].some((v) => v.status === "unavailable");
			if (!hasUnavailable) return; // skip if all parsers loaded
			for (const [, info] of status) {
				if (info.status === "unavailable") {
					expect(info.suggestion).toBeDefined();
					expect(info.suggestion!.length).toBeGreaterThan(0);
				}
			}
		});
	});

	describe("overview output includes parser warnings", () => {
		it("should warn LLM when parsers are unavailable", () => {
			const status = getParserStatus();
			const unavailable = [...status.entries()].filter(([, v]) => v.status === "unavailable");

			if (unavailable.length > 0) {
				// When there are unavailable parsers, the overview should mention them
				const graph = scanProject(".");
				const output = executeOverview(graph, ".");

				for (const [lang] of unavailable) {
					// The output should mention the unavailable language
					expect(output.toLowerCase()).toContain(lang);
				}
			} else {
				// All parsers loaded — verify no warning section exists
				const graph = scanProject(".");
				const output = executeOverview(graph, ".");
				expect(output).not.toContain("Parser Availability Warning");
			}
		});
	});

	describe("before-start hook injects language availability", () => {
		it("should include parser status in system prompt when parsers unavailable", () => {
			resetOverviewShown();
			const result = generateOverviewForPrompt(".");
			const status = getParserStatus();
			const unavailable = [...status.entries()].filter(([, v]) => v.status === "unavailable");

			if (unavailable.length > 0) {
				// System prompt should mention unavailable parsers
				for (const [lang] of unavailable) {
					expect(result.toLowerCase()).toContain(lang);
				}
			}
		});
	});
});

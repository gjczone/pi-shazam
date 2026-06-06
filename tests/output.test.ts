/**
 * Tests for core/output — token budget truncation.
 */
import { describe, it, expect } from "vitest";
import { estimateTokens, truncateOutput } from "../core/output.js";

describe("estimateTokens", () => {
	it("should return 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("should estimate ~4 chars per token for ASCII text", () => {
		const text = "hello world foo bar";
		const tokens = estimateTokens(text);
		expect(tokens).toBeGreaterThanOrEqual(3);
		expect(tokens).toBeLessThanOrEqual(7);
	});

	it("should scale linearly with text length", () => {
		const short = estimateTokens("hello");
		const long = estimateTokens("hello ".repeat(100));
		expect(long).toBeGreaterThan(short * 10);
	});

	it("should handle multi-line text", () => {
		const text = "line1\nline2\nline3\n";
		const tokens = estimateTokens(text);
		expect(tokens).toBeGreaterThan(0);
	});
});

describe("truncateOutput", () => {
	it("should return all lines when within budget", () => {
		const lines = ["## Result", "", "- item1", "- item2"];
		const result = truncateOutput(lines, 1000);
		expect(result).toContain("## Result");
		expect(result).toContain("item1");
		expect(result).toContain("item2");
		expect(result).not.toContain("truncated");
	});

	it("should truncate when exceeding budget", () => {
		const lines: string[] = ["## Result", ""];
		for (let i = 0; i < 200; i++) {
			lines.push(`- item ${i} with some description text to make it longer`);
		}
		const result = truncateOutput(lines, 50);
		expect(result).toContain("## Result");
		expect(result).toContain("truncated");
		expect(estimateTokens(result)).toBeLessThanOrEqual(80);
	});

	it("should preserve header lines (## and ###)", () => {
		const lines = ["## Result Summary", "", "### Details", ""];
		for (let i = 0; i < 100; i++) {
			lines.push(`- detail item ${i} with padding text here`);
		}
		const result = truncateOutput(lines, 30);
		expect(result).toContain("## Result Summary");
		expect(result).toContain("### Details");
	});

	it("should show truncation count in indicator", () => {
		const lines = ["## Result", ""];
		for (let i = 0; i < 50; i++) {
			lines.push(`- symbol_${i} at file_${i}.ts:${i} — some description`);
		}
		const result = truncateOutput(lines, 20);
		const match = result.match(/and (\d+) more/);
		expect(match).not.toBeNull();
		if (match) {
			const count = parseInt(match[1]!, 10);
			expect(count).toBeGreaterThan(0);
			expect(count).toBeLessThan(50);
		}
	});

	it("should handle empty input", () => {
		expect(truncateOutput([], 100)).toBe("");
	});

	it("should handle single line within budget", () => {
		const result = truncateOutput(["hello world"], 100);
		expect(result).toBe("hello world");
	});

	it("should prioritize top items over later items", () => {
		const lines = ["## Top Files", ""];
		for (let i = 0; i < 50; i++) {
			lines.push(
				`${i + 1}. \`module_${i}/deep/path/file.ts\` — ${100 - i} symbols, PageRank ${(1 - i * 0.01).toFixed(2)}`,
			);
		}
		const result = truncateOutput(lines, 40);
		expect(result).toContain("module_0");
		expect(result).toContain("module_1");
	});
});

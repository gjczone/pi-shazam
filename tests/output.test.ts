/**
 * Tests for core/output — token budget truncation.
 */
import { describe, it, expect, vi } from "vitest";
import { estimateTokens, truncateOutput, _logWarn } from "../core/output.js";

describe("estimateTokens", () => {
	it("should return 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("should estimate ~2 chars per token for ASCII text (#555)", () => {
		const text = "hello world foo bar"; // 19 chars
		const tokens = estimateTokens(text);
		// Conservative ratio (was 4 chars/token; now 2 to stay safe for CJK).
		// 19 chars / 2 = 9.5 -> ceil = 10 tokens. With the old ratio (4) this
		// would be 5 tokens, so the lower bound 8 makes this a red test pre-fix.
		expect(tokens).toBeGreaterThanOrEqual(8);
		expect(tokens).toBeLessThanOrEqual(12);
	});

	it("should estimate CJK text conservatively (#555)", () => {
		// 100 CJK chars: old 4-chars/token heuristic said 25 tokens, but CJK
		// is typically 1-2 BPE tokens per char, so the real cost is 100-200.
		// The new 2-chars/token ratio must estimate >= 50 tokens.
		const cjk = "你好".repeat(50); // 100 chars
		const tokens = estimateTokens(cjk);
		expect(tokens).toBeGreaterThanOrEqual(50);
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
		// Budget tuned for the 2-chars/token ratio (#555): enough to keep a few
		// lines but truncate most, so the count is > 0 and < 50.
		const result = truncateOutput(lines, 100);
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
		// Budget tuned for the 2-chars/token ratio (#555): enough to keep the
		// first two modules before truncation kicks in.
		const result = truncateOutput(lines, 80);
		expect(result).toContain("module_0");
		expect(result).toContain("module_1");
	});

	it("should keep CJK-heavy output within the token budget (#555)", () => {
		// 1000-char CJK string split into lines; maxTokens=100.
		// With the old 4-chars/token ratio, estimateTokens(1000 CJK) = 250, so
		// the budget guard (totalTokens <= maxTokens) would NOT truncate and
		// the full 1000 chars would be returned -- exceeding the real budget.
		// With 2 chars/token, estimateTokens(1000 CJK) = 500 > 100, so
		// truncation fires and the result must stay within budget.
		const cjkLine = "你好世界测试代码分析".repeat(10); // 100 chars per line
		const lines: string[] = ["## CJK Overview", ""];
		for (let i = 0; i < 10; i++) {
			lines.push(`- 项目编号 ${i}: ${cjkLine}`);
		}
		const result = truncateOutput(lines, 100);
		expect(estimateTokens(result)).toBeLessThanOrEqual(100);
	});
});

describe("_logWarn", () => {
	it("should NOT suppress ENOENT errors globally (#551)", () => {
		// The blanket ENOENT early-return was removed; callers that genuinely
		// expect ENOENT now add their own local guard (see core/scanner.ts:141,
		// core/git-hooks.ts). _logWarn itself must always record the warning so
		// operators can diagnose broken LSP / broken state.
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		_logWarn("isExecutable", "statSync failed", err);
		expect(spy).toHaveBeenCalledTimes(1);
		const msg = spy.mock.calls[0][0] as string;
		expect(msg).toContain("ENOENT: no such file");
		spy.mockRestore();
	});

	it("should print concise message for other errors", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const err = new Error("Permission denied");
		_logWarn("isExecutable", "statSync failed", err);
		expect(spy).toHaveBeenCalledTimes(1);
		const msg = spy.mock.calls[0][0] as string;
		expect(msg).toContain("Permission denied");
		expect(msg).not.toContain("at statSync"); // no stack trace
		spy.mockRestore();
	});

	it("should handle non-Error objects", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		_logWarn("test", "something happened", "just a string");
		expect(spy).toHaveBeenCalledTimes(1);
		const msg = spy.mock.calls[0][0] as string;
		expect(msg).toContain("just a string");
		spy.mockRestore();
	});
});

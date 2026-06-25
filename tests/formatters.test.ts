import { describe, it, expect, vi } from "vitest";
import { detectFormatters } from "../core/formatters.js";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function setupTempDir(): string {
	const dir = join(tmpdir(), `pi-shazam-format-test-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("core/formatters", () => {
	it("should return ['prettier'] for dir with .prettierrc", () => {
		const dir = setupTempDir();
		try {
			writeFileSync(join(dir, ".prettierrc"), "{}");
			const result = detectFormatters(dir);
			expect(result).toContain("prettier");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should return ['prettier'] for dir with prettier.config.mjs", () => {
		const dir = setupTempDir();
		try {
			writeFileSync(join(dir, "prettier.config.mjs"), "export default {};");
			const result = detectFormatters(dir);
			expect(result).toContain("prettier");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should return ['eslint', 'prettier'] for dir with both configs", () => {
		const dir = setupTempDir();
		try {
			writeFileSync(join(dir, ".prettierrc"), "{}");
			writeFileSync(join(dir, "eslint.config.js"), "module.exports = {};");
			const result = detectFormatters(dir);
			expect(result).toContain("prettier");
			expect(result).toContain("eslint");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should return ['gofmt'] for dir with go.mod", () => {
		const dir = setupTempDir();
		try {
			writeFileSync(join(dir, "go.mod"), "module test");
			const result = detectFormatters(dir);
			expect(result).toContain("gofmt");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should return [] for dir with no formatter configs", () => {
		const dir = setupTempDir();
		try {
			const result = detectFormatters(dir);
			expect(result).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("should not emit ENOENT console.warn when package.json does not exist (#459)", () => {
		const dir = setupTempDir();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Create a Rust-like project dir (has Cargo.toml, no package.json)
			writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"test\"");
			detectFormatters(dir);
			// Filter for ENOENT-related warnings from readFileAdaptive
			const enoentWarnings = warnSpy.mock.calls.filter(
				(args) =>
					args.some((a) => typeof a === "string" && a.includes("ENOENT")) ||
					args.some((a) => typeof a === "string" && a.includes("stat failed")),
			);
			expect(enoentWarnings).toEqual([]);
		} finally {
			warnSpy.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

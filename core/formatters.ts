/**
 * pi-shazam core/formatters -- Shared formatter detection.
 *
 * Single source of truth for detecting which formatters/linters are
 * configured in a project. Consumed by tools/fix.ts and hooks/shazam-guide.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileAdaptive } from "./encoding.js";
import { _logWarn } from "./output.js";

/**
 * Standard Prettier config file names, in conventional precedence order.
 * Single source of truth for Prettier config detection (issue #571 step 5).
 * tools/format.ts was missing .prettierrc.js before consolidation.
 */
export const PRETTIER_CONFIG_FILES = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.js",
	"prettier.config.js",
	"prettier.config.mjs",
] as const;

/**
 * Language marker files and their associated language names.
 * Used by detectProjectLanguages to determine which languages
 * a project uses. Single source of truth (issue #571 step 6).
 */
const LANGUAGE_MARKERS: readonly (readonly [string, string])[] = [
	["tsconfig.json", "typescript"],
	["Cargo.toml", "rust"],
	["go.mod", "go"],
	["pyproject.toml", "python"],
	["setup.py", "python"],
	["requirements.txt", "python"],
	["package.json", "node"],
	["pom.xml", "java"],
	["build.gradle", "java"],
	["pubspec.yaml", "dart"],
];

/**
 * Detect which programming languages a project uses,
 * based on the presence of language marker files.
 *
 * Returns an array of language names (e.g., ["typescript", "python"]).
 * Languages are returned in marker precedence order (tsconfig.json
 * before package.json, etc.). Deduplicated -- "python" appears at most
 * once even if both pyproject.toml and setup.py exist.
 *
 * Single source of truth for project language detection (issue #571 step 6).
 * Replaces inline detection in verify.ts, git-hooks.ts, and git-utils.ts.
 */
export function detectProjectLanguages(projectRoot: string): string[] {
	const seen = new Set<string>();
	const languages: string[] = [];
	for (const [marker, lang] of LANGUAGE_MARKERS) {
		if (seen.has(lang)) continue;
		if (existsSync(join(projectRoot, marker))) {
			seen.add(lang);
			languages.push(lang);
		}
	}
	return languages;
}

/**
 * Detect available formatters from project config files.
 * Returns a deduplicated list of formatter names.
 */
export function detectFormatters(projectRoot: string): string[] {
	const formatters: string[] = [];

	// Prettier (standalone config files)
	if (PRETTIER_CONFIG_FILES.some((f) => existsSync(join(projectRoot, f)))) {
		formatters.push("prettier");
	}

	// ESLint
	if (
		existsSync(join(projectRoot, ".eslintrc.js")) ||
		existsSync(join(projectRoot, ".eslintrc.cjs")) ||
		existsSync(join(projectRoot, ".eslintrc.json")) ||
		existsSync(join(projectRoot, ".eslintrc.yaml")) ||
		existsSync(join(projectRoot, ".eslintrc.yml")) ||
		existsSync(join(projectRoot, "eslint.config.js")) ||
		existsSync(join(projectRoot, "eslint.config.mjs"))
	) {
		formatters.push("eslint");
	}

	// Biome
	if (existsSync(join(projectRoot, "biome.json")) || existsSync(join(projectRoot, "biome.jsonc"))) {
		formatters.push("biome");
	}

	// Check package.json for embedded config
	if (existsSync(join(projectRoot, "package.json"))) {
		try {
			const pkgRaw = readFileAdaptive(join(projectRoot, "package.json"));
			const pkg = JSON.parse(pkgRaw);
			if (pkg.prettier) formatters.push("prettier");
			if (pkg.eslintConfig) formatters.push("eslint");
		} catch (err) {
			_logWarn("detectFormatters", "package.json parse failed", err);
			// package.json invalid -- continue
		}
	}

	// .editorconfig
	if (existsSync(join(projectRoot, ".editorconfig"))) {
		formatters.push("editorconfig");
	}

	// Python ruff
	if (existsSync(join(projectRoot, "ruff.toml"))) {
		formatters.push("ruff");
	} else if (existsSync(join(projectRoot, "pyproject.toml"))) {
		try {
			const pyproject = readFileAdaptive(join(projectRoot, "pyproject.toml"));
			if (pyproject.includes("[tool.ruff")) formatters.push("ruff");
		} catch (err) {
			_logWarn("detectFormatters", "pyproject.toml parse failed", err);
		}
	}

	// Rust rustfmt
	if (existsSync(join(projectRoot, "rustfmt.toml"))) {
		formatters.push("rustfmt");
	} else if (existsSync(join(projectRoot, ".rustfmt.toml"))) {
		formatters.push("rustfmt");
	} else if (existsSync(join(projectRoot, "Cargo.toml"))) {
		try {
			const cargo = readFileAdaptive(join(projectRoot, "Cargo.toml"));
			if (cargo.includes("[package]")) formatters.push("rustfmt");
		} catch (err) {
			_logWarn("detectFormatters", "Cargo.toml parse failed", err);
		}
	}

	// Go gofmt
	if (existsSync(join(projectRoot, "go.mod"))) {
		formatters.push("gofmt");
	}

	return [...new Set(formatters)];
}

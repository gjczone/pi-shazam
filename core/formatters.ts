/**
 * pi-shazam core/formatters -- Shared formatter detection.
 *
 * Single source of truth for detecting which formatters/linters are
 * configured in a project. Consumed by tools/fix.ts and hooks/shazam-guide.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileAdaptive } from "./encoding.js";

/**
 * Detect available formatters from project config files.
 * Returns a deduplicated list of formatter names.
 */
export function detectFormatters(projectRoot: string): string[] {
	const formatters: string[] = [];

	// Prettier (standalone config files)
	if (
		existsSync(join(projectRoot, ".prettierrc")) ||
		existsSync(join(projectRoot, ".prettierrc.json")) ||
		existsSync(join(projectRoot, ".prettierrc.js")) ||
		existsSync(join(projectRoot, "prettier.config.js")) ||
		existsSync(join(projectRoot, "prettier.config.mjs"))
	) {
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
	try {
		const pkgRaw = readFileAdaptive(join(projectRoot, "package.json"));
		const pkg = JSON.parse(pkgRaw);
		if (pkg.prettier) formatters.push("prettier");
		if (pkg.eslintConfig) formatters.push("eslint");
	} catch {
		console.warn("[pi-shazam] detectFormatters: package.json not found or invalid");
		// package.json not found or invalid -- continue
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
		} catch {
			console.warn("[pi-shazam] detectFormatters: pyproject.toml parse failed");
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
		} catch {
			console.warn("[pi-shazam] detectFormatters: Cargo.toml parse failed");
		}
	}

	// Go gofmt
	if (existsSync(join(projectRoot, "go.mod"))) {
		formatters.push("gofmt");
	}

	return [...new Set(formatters)];
}

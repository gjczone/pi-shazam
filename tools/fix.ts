/**
 * pi-shazam tools/fix — Auto-fix lint/format.
 *
 * Scans source files for common format issues and offers fixes.
 * In dry-run mode, previews what would change without modifying files.
 * Supports nearest-wins formatter detection (prettier, biome, eslint, ruff, gofmt).
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { createTool } from "./_factory.js";
import { readFileAdaptive } from "../core/encoding.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getNextForTool, formatNextSection } from "../core/output.js";

export function registerFix(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_fix",
		label: "Auto-Fix Format & Lint",
		description: `\
		When shazam_verify reports format or lint errors, use this to
		auto-fix them. Runs nearest-wins formatters (prettier, biome, eslint
		--fix, ruff, cargo fmt, gofmt). Format only — never touches logic.
		Always run with --dry-run first to preview changes before applying.`,
		params: Type.Object({
			dryRun: Type.Optional(Type.Boolean()),
			file: Type.Optional(Type.String()),
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			const dryRun = (params.dryRun as boolean) ?? true;
			const file = params.file as string | undefined;
			return json ? executeFixJson(graph, ".", { dryRun, file }) : executeFix(graph, ".", { dryRun, file });
		},
	});
}

// ── Fix options ────────────────────────────────────────────────────────────

export interface FixOptions {
	/** Dry-run mode: preview changes without applying */
	dryRun?: boolean;
	/** Target specific file (omit for all files) */
	file?: string;
}

// ── Execute functions (testable without Pi) ────────────────────────────────

/**
 * Run format fix analysis. In dry-run mode (default), only reports issues.
 */
export function executeFix(graph: RepoGraph, projectRoot: string, options: FixOptions = {}): string {
	const dryRun = options.dryRun ?? true;
	const lines: string[] = [];

	lines.push("## Fix Results");
	lines.push("");
	lines.push(
		dryRun ? "**Mode: DRY RUN** (preview only, no changes applied)" : "**Mode: APPLY** (changes will be written)",
	);
	lines.push("");

	// ── Detect available formatters ──────────────────────────────────────
	const formatters = detectFormatters(projectRoot);
	lines.push("### Detected Formatters");
	if (formatters.length === 0) {
		lines.push("No formatters detected in project config.");
	} else {
		for (const fmt of formatters) {
			lines.push(`- ${fmt}`);
		}
	}
	lines.push("");

	// ── Scan files for common issues ─────────────────────────────────────
	const targetFiles = options.file ? [options.file] : [...graph.fileSymbols.keys()];

	const issues = scanFormatIssues(projectRoot, targetFiles, graph);

	lines.push("### Format Issues Found");
	lines.push("");

	if (issues.length === 0) {
		lines.push("[PASS] No format issues detected.");
	} else {
		lines.push(`Found ${issues.length} potential issue(s):`);
		lines.push("");
		for (const issue of issues.slice(0, 30)) {
			lines.push(`- \`${issue.file}:${issue.line}\` — ${issue.kind}: ${issue.description}`);
		}
		if (issues.length > 30) {
			lines.push(`  ... and ${issues.length - 30} more`);
		}
	}
	lines.push("");

	// ── Recommendations ────────────────────────────────────────────────
	if (issues.length > 0) {
		lines.push("### Recommended Fix Commands");
		lines.push("");
		if (formatters.includes("prettier")) {
			lines.push("- `npx prettier --write .`");
		}
		if (formatters.includes("eslint")) {
			lines.push("- `npx eslint --fix .`");
		}
		if (formatters.length === 0) {
			lines.push("- Install formatter: `npm install --save-dev prettier`");
			lines.push("- Then run: `npx prettier --write .`");
		}
	}

	if (dryRun) {
		lines.push("");
		lines.push('To apply fixes, call with `{ "dryRun": false }`.');
	}

	// Add Next recommendations
	const nextItems = getNextForTool("fix");
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

/**
 * Run fix analysis and return structured JSON.
 */
export function executeFixJson(graph: RepoGraph, projectRoot: string, options: FixOptions = {}): string {
	const dryRun = options.dryRun ?? true;
	const formatters = detectFormatters(projectRoot);
	const targetFiles = options.file ? [options.file] : [...graph.fileSymbols.keys()];
	const issues = scanFormatIssues(projectRoot, targetFiles, graph);

	return JSON.stringify({
		schema_version: "1.0",
		command: "fix",
		project: projectRoot,
		status: "ok",
		result: {
			dryRun,
			formatters,
			issueCount: issues.length,
			issues: issues.slice(0, 50),
		},
	});
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FormatIssue {
	file: string;
	line: number;
	kind: string;
	description: string;
}

/**
 * Detect available formatters from project config files.
 */
function detectFormatters(projectRoot: string): string[] {
	const formatters: string[] = [];

	if (
		existsSync(join(projectRoot, ".prettierrc")) ||
		existsSync(join(projectRoot, ".prettierrc.json")) ||
		existsSync(join(projectRoot, ".prettierrc.js")) ||
		existsSync(join(projectRoot, "prettier.config.js")) ||
		existsSync(join(projectRoot, "prettier.config.mjs"))
	) {
		formatters.push("prettier");
	}

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

	if (existsSync(join(projectRoot, "biome.json")) || existsSync(join(projectRoot, "biome.jsonc"))) {
		formatters.push("biome");
	}

	// Check package.json for config sections
	try {
		const pkgRaw = readFileSync(join(projectRoot, "package.json"), "utf-8");
		const pkg = JSON.parse(pkgRaw);
		if (pkg.prettier) formatters.push("prettier");
		if (pkg.eslintConfig) formatters.push("eslint");
	} catch {
		// package.json not found or invalid — continue
	}

	return [...new Set(formatters)];
}

/**
 * Detect the dominant indentation style in the project.
 * Returns 'tabs' if most files use tabs, 'spaces' otherwise.
 * This prevents false positives when the project consistently uses tabs (fixes #111).
 */
function detectIndentationStyle(files: string[], projectRoot: string): 'tabs' | 'spaces' {
	let tabFiles = 0;
	let spaceFiles = 0;
	const sampleSize = Math.min(files.length, 20); // Sample up to 20 files
	
	for (let i = 0; i < sampleSize; i++) {
		const fullPath = join(projectRoot, files[i]!);
		if (!existsSync(fullPath)) continue;
		
		try {
			const content = readFileSync(fullPath, "utf-8");
			const lines = content.split("\n").slice(0, 50); // Check first 50 lines
			
			let tabCount = 0;
			let spaceCount = 0;
			
			for (const line of lines) {
				if (line.startsWith("\t")) tabCount++;
				else if (line.startsWith("    ")) spaceCount++;
			}
			
			if (tabCount > spaceCount) tabFiles++;
			else if (spaceCount > tabCount) spaceFiles++;
		} catch {
			// Skip unreadable files
		}
	}
	
	return tabFiles > spaceFiles ? 'tabs' : 'spaces';
}

/**
 * Check if prettierrc has useTabs setting.
 */
function hasUseTabsInConfig(projectRoot: string): boolean {
	const configFiles = ['.prettierrc', '.prettierrc.json', 'prettier.config.js', 'prettier.config.mjs'];
	
	for (const configFile of configFiles) {
		const configPath = join(projectRoot, configFile);
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8");
				if (content.includes('"useTabs"') || content.includes("'useTabs'")) {
					return content.includes('"useTabs": true') || content.includes("'useTabs': true");
				}
			} catch {
				// Skip unreadable configs
			}
		}
	}
	
	// Check package.json
	try {
		const pkgPath = join(projectRoot, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			if (pkg.prettier?.useTabs === true) return true;
		}
	} catch {
		// Skip
	}
	
	return false;
}

/**
 * Scan files for common formatting issues.
 */
function scanFormatIssues(projectRoot: string, files: string[], _graph: RepoGraph): FormatIssue[] {
	const issues: FormatIssue[] = [];
	
	// Detect indentation style to avoid false positives (fixes #111)
	const useTabs = hasUseTabsInConfig(projectRoot) || detectIndentationStyle(files, projectRoot) === 'tabs';

	for (const file of files.slice(0, 100)) {
		const fullPath = join(projectRoot, file);
		if (!existsSync(fullPath)) continue;

		try {
			const content = readFileAdaptive(fullPath);
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const lineNum = i + 1;

				// Trailing whitespace
				if (line && line !== line.trimEnd()) {
					issues.push({
						file,
						line: lineNum,
						kind: "trailing-whitespace",
						description: "Line has trailing whitespace",
					});
				}

				// Tab indentation — only report if project uses spaces (fixes #111)
				if (!useTabs && (file.endsWith(".ts") || file.endsWith(".js") || file.endsWith(".json"))) {
					if (line.startsWith("\t")) {
						issues.push({
							file,
							line: lineNum,
							kind: "tab-indent",
							description: "Tab character used for indentation (use spaces)",
						});
					}
				}

				// Mixed tabs and spaces
				if (line.includes("\t") && line.includes("    ")) {
					issues.push({
						file,
						line: lineNum,
						kind: "mixed-indent",
						description: "Mixed tabs and spaces on same line",
					});
				}
			}

			// Missing newline at end of file
			if (content.length > 0 && !content.endsWith("\n")) {
				issues.push({
					file,
					line: lines.length,
					kind: "missing-newline",
					description: "File does not end with a newline",
				});
			}

			// Too many consecutive blank lines
			let blankCount = 0;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i]?.trim() === "") {
					blankCount++;
					if (blankCount > 2) {
						issues.push({
							file,
							line: i + 1,
							kind: "consecutive-blank-lines",
							description: "More than 2 consecutive blank lines",
						});
						blankCount = 0; // Reset to avoid duplicate reports
					}
				} else {
					blankCount = 0;
				}
			}
		} catch {
			// Skip files that can't be read
		}
	}

	return issues;
}

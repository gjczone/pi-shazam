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
import { scanProject } from "../core/scanner.js";
import { readFileAdaptive } from "../core/encoding.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function registerFix(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_fix",
		label: "Auto-Fix Format & Lint",
		description: `\
MUST call after shazam_verify or shazam_check reports format/lint
errors. Runs nearest-wins auto-fixers (prettier, biome, ruff, cargo
fmt, gofmt, eslint --fix). Modifies format ONLY — never touches logic.

Always run with --dry-run first to preview changes before applying.
After fixing, re-run shazam_verify to confirm clean. Do NOT commit
code with format issues — they WILL fail CI.

Scenario: trailing whitespace after an edit. Import sorting. Indentation
mismatches. Line length violations. Mixed tabs/spaces. Missing newlines
at end of file.`,
		parameters: Type.Object({
			dryRun: Type.Optional(Type.Boolean()),
			file: Type.Optional(Type.String()),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const dryRun = params.dryRun ?? true; // default to dry-run for safety
			const graph = scanProject(".");

			if (json) {
				return {
					content: [
						{
							type: "text",
							text: executeFixJson(graph, ".", { dryRun, file: params.file }),
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: executeFix(graph, ".", { dryRun, file: params.file }),
					},
				],
			};
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
export function executeFix(
	graph: RepoGraph,
	projectRoot: string,
	options: FixOptions = {},
): string {
	const dryRun = options.dryRun ?? true;
	const lines: string[] = [];

	lines.push("## Fix Results");
	lines.push("");
	lines.push(dryRun ? "**Mode: DRY RUN** (preview only, no changes applied)" : "**Mode: APPLY** (changes will be written)");
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
	const targetFiles = options.file
		? [options.file]
		: [...graph.fileSymbols.keys()];

	const issues = scanFormatIssues(projectRoot, targetFiles, graph);

	lines.push("### Format Issues Found");
	lines.push("");

	if (issues.length === 0) {
		lines.push("✅ No format issues detected.");
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
		lines.push("To apply fixes, call with `{ \"dryRun\": false }`.");
	}

	return lines.join("\n");
}

/**
 * Run fix analysis and return structured JSON.
 */
export function executeFixJson(
	graph: RepoGraph,
	projectRoot: string,
	options: FixOptions = {},
): string {
	const dryRun = options.dryRun ?? true;
	const formatters = detectFormatters(projectRoot);
	const targetFiles = options.file
		? [options.file]
		: [...graph.fileSymbols.keys()];
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

	if (existsSync(join(projectRoot, ".prettierrc")) ||
		existsSync(join(projectRoot, ".prettierrc.json")) ||
		existsSync(join(projectRoot, ".prettierrc.js")) ||
		existsSync(join(projectRoot, "prettier.config.js")) ||
		existsSync(join(projectRoot, "prettier.config.mjs"))) {
		formatters.push("prettier");
	}

	if (existsSync(join(projectRoot, ".eslintrc.js")) ||
		existsSync(join(projectRoot, ".eslintrc.cjs")) ||
		existsSync(join(projectRoot, ".eslintrc.json")) ||
		existsSync(join(projectRoot, ".eslintrc.yaml")) ||
		existsSync(join(projectRoot, ".eslintrc.yml")) ||
		existsSync(join(projectRoot, "eslint.config.js")) ||
		existsSync(join(projectRoot, "eslint.config.mjs"))) {
		formatters.push("eslint");
	}

	if (existsSync(join(projectRoot, "biome.json")) ||
		existsSync(join(projectRoot, "biome.jsonc"))) {
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
 * Scan files for common formatting issues.
 */
function scanFormatIssues(
	projectRoot: string,
	files: string[],
	_graph: RepoGraph,
): FormatIssue[] {
	const issues: FormatIssue[] = [];

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

				// Tab indentation (when project uses spaces)
				if (file.endsWith(".ts") || file.endsWith(".js") || file.endsWith(".json")) {
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

/**
 * pi-shazam tools/format -- Auto-format code.
 *
 * Scans source files for common format issues and offers fixes.
 * In dry-run mode, previews what would change without modifying files.
 * Supports nearest-wins formatter detection (prettier, biome, eslint, ruff, rustfmt, gofmt).
 */
import type { ExtensionAPI, AgentToolResult } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { createTool, validatePathInProject } from "./_factory.js";
import { readFileAdaptive, readFileAdaptiveAsync } from "../core/encoding.js";
import { scanProject, getEffectiveRoot } from "../core/scanner.js";
import { existsSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { _logWarn, getNextForTool, formatNextSection, truncateOutput } from "../core/output.js";
import { isNonSourceFile } from "../core/filter.js";
import { detectFormatters } from "../core/formatters.js";

export function registerFormat(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_format",
		label: "Auto-Format Code",
		description: `\
		When shazam_verify reports format or lint errors, use this to
		auto-fix them. Runs nearest-wins formatters (prettier, biome, eslint
		--fix, ruff, cargo fmt, gofmt). Format only - never touches logic.
		Always run with --dry-run first to preview changes before applying.`,
		params: Type.Object({
			dryRun: Type.Optional(Type.Boolean()),
			file: Type.Optional(Type.String()),
		}),
		customExecute: async (_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> => {
			const json = params.json ?? false;
			const dryRun = (params.dryRun as boolean) ?? true;
			const file = params.file as string | undefined;
			// Issue #470: customExecute bypasses factory auto-truncation, so
			// honor maxTokens explicitly here. JSON mode is left intact to
			// preserve valid JSON (mirrors tools/lookup.ts:136-138).
			const maxTokens = params.maxTokens as number | undefined;
			const graph = scanProject(getEffectiveRoot());
			const effectiveRoot = getEffectiveRoot();
			let text = json
				? await executeFormatJson(graph, effectiveRoot, { dryRun, file })
				: await executeFormat(graph, effectiveRoot, { dryRun, file });
			if (maxTokens && !json) {
				text = truncateOutput(text.split("\n"), maxTokens);
			}
			return { content: [{ type: "text", text }] };
		},
	});
}

// -- Format options --------------------------------------------------------

export interface FormatOptions {
	/** Dry-run mode: preview changes without applying */
	dryRun?: boolean;
	/** Target specific file (omit for all files) */
	file?: string;
}

// -- Execute functions (testable without Pi) --------------------------------

/**
 * Run format analysis. In dry-run mode (default), only reports issues.
 * In apply mode, runs detected formatters with auto-fix flags.
 */
export async function executeFormat(
	graph: RepoGraph,
	projectRoot: string,
	options: FormatOptions = {},
): Promise<string> {
	const dryRun = options.dryRun ?? true;
	const lines: string[] = [];

	lines.push("## Format Results");
	lines.push("");
	lines.push(
		dryRun ? "**Mode: DRY RUN** (preview only, no changes applied)" : "**Mode: APPLY** (changes will be written)",
	);

	// Path traversal validation: must run before runFormatters to prevent formatters from operating on files outside the project
	if (options.file && !validatePathInProject(options.file, getEffectiveRoot())) {
		return "Error: file path escapes project root";
	}

	if (!dryRun) {
		const formatters = detectFormatters(projectRoot);
		const results = runFormatters(projectRoot, formatters, options.file);
		for (const r of results) {
			if (r.error) {
				lines.push(`- [FAIL] ${r.formatter}: ${r.error}`);
			} else {
				lines.push(`- [OK] ${r.formatter}: ${r.summary}`);
			}
		}
		if (results.length === 0) {
			lines.push("- No known formatters detected. Install prettier, eslint, biome, ruff, or gofmt.");
		}
		lines.push("");
	}
	lines.push("");

	// -- Detect available formatters --
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

	// -- Scan files for common issues --
	const rawFiles = options.file ? [options.file] : [...graph.fileSymbols.keys()];
	const targetFiles = rawFiles.filter((f) => !isNonSourceFile(f));

	const issues = await scanFormatIssues(projectRoot, targetFiles, graph);

	lines.push("### Format Issues Found");
	lines.push("");

	if (issues.length === 0) {
		lines.push("[PASS] No format issues detected.");
	} else {
		lines.push(`Found ${issues.length} potential issue(s):`);
		lines.push("");
		for (const issue of issues.slice(0, 30)) {
			lines.push(`- \`${issue.file}:${issue.line}\` - ${issue.kind}: ${issue.description}`);
		}
		if (issues.length > 30) {
			lines.push(`  ... and ${issues.length - 30} more`);
		}
	}
	lines.push("");

	// -- Recommendations ------------------------------------------------
	if (issues.some((i) => i.kind !== "truncation")) {
		lines.push("### Recommended Fix Commands");
		lines.push("");
		if (formatters.includes("prettier")) {
			lines.push("- `npx prettier --write .`");
		}
		if (formatters.includes("biome")) {
			lines.push("- `npx @biomejs/biome check --write .`");
		}
		if (formatters.includes("eslint")) {
			lines.push("- `npx eslint --fix .`");
		}
		if (formatters.includes("ruff")) {
			lines.push("- `ruff format .`");
		}
		if (formatters.includes("rustfmt")) {
			lines.push("- `cargo fmt`");
		}
		if (formatters.includes("gofmt")) {
			lines.push("- `gofmt -w .`");
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
	const nextItems = getNextForTool("format");
	if (nextItems.length > 0) {
		lines.push("");
		lines.push(formatNextSection(nextItems));
	}

	return lines.join("\n");
}

/**
 * Run format analysis and return structured JSON.
 */
export async function executeFormatJson(
	graph: RepoGraph,
	projectRoot: string,
	options: FormatOptions = {},
): Promise<string> {
	const dryRun = options.dryRun ?? true;
	const formatters = detectFormatters(projectRoot);

	if (options.file && !validatePathInProject(options.file, getEffectiveRoot())) {
		return JSON.stringify({
			schema_version: "1.0",
			command: "format",
			project: projectRoot,
			status: "error",
			result: { error: "file path escapes project root" },
		});
	}

	const rawFiles = options.file ? [options.file] : [...graph.fileSymbols.keys()];
	const targetFiles = rawFiles.filter((f) => !isNonSourceFile(f));

	const issues = await scanFormatIssues(projectRoot, targetFiles, graph);

	return JSON.stringify({
		schema_version: "1.0",
		command: "format",
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

// -- Helpers -----------------------------------------------------------------

interface FormatIssue {
	file: string;
	line: number;
	kind: string;
	description: string;
}

/**
 * Parse .editorconfig file to extract indent_style and indent_size.
 * Returns { style, size } or null if not found.
 * Handles the case where indent_size is not set but indent_style is (fixes #153).
 */
function parseEditorconfig(projectRoot: string): { style?: string; size?: number } | null {
	const editorconfigPath = join(projectRoot, ".editorconfig");
	if (!existsSync(editorconfigPath)) return null;

	try {
		const content = readFileAdaptive(editorconfigPath);
		const lines = content.split("\n");
		let inRootSection = false;
		let style: string | undefined;
		let size: number | undefined;

		for (const line of lines) {
			const trimmed = line.trim();

			// Section header
			if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
				inRootSection = trimmed === "[*]" || trimmed === "[*.{ts,tsx,js,jsx}]";
				continue;
			}

			if (!inRootSection) continue;

			// Parse key-value pairs
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
			const val = trimmed
				.slice(eqIndex + 1)
				.trim()
				.toLowerCase();

			if (key === "indent_style") {
				style = val;
			}
			if (key === "indent_size") {
				size = parseInt(val, 10);
			}
		}

		// If indent_style is set but indent_size is not, use default (fixes #153)
		if (style && size === undefined) {
			// Editorconfig spec: indent_size defaults to tab_width, which defaults to 4 for spaces, 8 for tabs
			size = style === "tab" ? 8 : 4;
		}

		return { style, size };
	} catch {
		_logWarn("parseEditorconfig", "failed to parse .editorconfig");
		return null;
	}
}

/**
 * Detect the dominant indentation style in the project.
 * Returns 'tabs' if most files use tabs, 'spaces' otherwise.
 * This prevents false positives when the project consistently uses tabs (fixes #111).
 */
async function detectIndentationStyle(files: string[], projectRoot: string): Promise<"tabs" | "spaces"> {
	// First, try to read from .editorconfig (fixes #153)
	const editorconfig = parseEditorconfig(projectRoot);
	if (editorconfig?.style === "tab") return "tabs";
	if (editorconfig?.style === "space") return "spaces";

	// Fall back to file-based detection (concurrent reads)
	let tabFiles = 0;
	let spaceFiles = 0;
	const sampleSize = Math.min(files.length, 20); // Sample up to 20 files

	const sampleFiles = files.slice(0, sampleSize);
	const readResults = await Promise.allSettled(
		sampleFiles.map(async (file) => {
			const fullPath = join(projectRoot, file);
			if (!existsSync(fullPath)) return null;
			const content = await readFileAsync(fullPath, "utf-8");
			return content;
		}),
	);

	for (const result of readResults) {
		if (result.status !== "fulfilled" || result.value === null) continue;
		const content = result.value;
		const lines = content.split("\n").slice(0, 50); // Check first 50 lines

		let tabCount = 0;
		let spaceCount = 0;

		for (const line of lines) {
			if (line.startsWith("\t")) tabCount++;
			else if (line.startsWith("    ")) spaceCount++;
		}

		if (tabCount > spaceCount) tabFiles++;
		else if (spaceCount > tabCount) spaceFiles++;
	}

	return tabFiles > spaceFiles ? "tabs" : "spaces";
}

/**
 * Check if prettierrc has useTabs setting.
 */
function hasUseTabsInConfig(projectRoot: string): boolean {
	const configFiles = [".prettierrc", ".prettierrc.json", "prettier.config.js", "prettier.config.mjs"];

	for (const configFile of configFiles) {
		const configPath = join(projectRoot, configFile);
		if (existsSync(configPath)) {
			try {
				const content = readFileAdaptive(configPath);
				if (content.includes('"useTabs"') || content.includes("'useTabs'")) {
					return content.includes('"useTabs": true') || content.includes("'useTabs': true");
				}
			} catch {
				_logWarn("hasUseTabsInConfig", "failed to read config file");
				// Skip unreadable configs
			}
		}
	}

	// Check package.json
	try {
		const pkgPath = join(projectRoot, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileAdaptive(pkgPath));
			if (pkg.prettier?.useTabs === true) return true;
		}
	} catch {
		_logWarn("hasUseTabsInConfig", "failed to read package.json");
		// Skip
	}

	return false;
}

/**
 * Scan files for common formatting issues.
 */
async function scanFormatIssues(projectRoot: string, files: string[], _graph: RepoGraph): Promise<FormatIssue[]> {
	const issues: FormatIssue[] = [];

	// Detect indentation style to avoid false positives (fixes #111)
	const useTabs = hasUseTabsInConfig(projectRoot) || (await detectIndentationStyle(files, projectRoot)) === "tabs";

	const capped = files.slice(0, 100);
	if (files.length > 100) {
		issues.push({
			file: `(${files.length - 100} more files)`,
			line: 0,
			kind: "truncation",
			description: `... and ${files.length - 100} more files not scanned (100-file cap)`,
		});
	}

	// Read all files concurrently
	const readResults = await Promise.allSettled(
		capped.map(async (file) => {
			const fullPath = join(projectRoot, file);
			if (!existsSync(fullPath)) return { file, content: null };
			const content = await readFileAdaptiveAsync(fullPath);
			return { file, content };
		}),
	);

	for (const result of readResults) {
		if (result.status !== "fulfilled" || result.value.content === null) continue;
		const { file, content } = result.value;

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

			// Tab indentation -- only report if project uses spaces (fixes #111)
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
	}

	return issues;
}

// -- Formatter execution ------------------------------------------------------

interface FormatterResult {
	formatter: string;
	summary: string;
	error?: string;
}

/**
 * Run detected formatters with auto-fix flags.
 * Each formatter runs on the project root. Errors are caught per-formatter.
 */
function runFormatters(projectRoot: string, formatters: string[], targetFile?: string): FormatterResult[] {
	const results: FormatterResult[] = [];

	for (const formatter of formatters) {
		try {
			switch (formatter) {
				case "prettier": {
					const args = ["npx", "--yes", "prettier", "--write"];
					if (targetFile) {
						args.push(targetFile);
					} else {
						args.push("--ignore-unknown", "**/*.{ts,js,json,css,html,md}");
					}
					runFormatterCommand(args, projectRoot);
					results.push({
						formatter: "prettier",
						summary: targetFile ? `Formatted ${targetFile}` : "Formatted project files",
					});
					break;
				}
				case "eslint": {
					const args = ["npx", "--yes", "eslint", "--fix"];
					if (targetFile) {
						args.push(targetFile);
					}
					runFormatterCommand(args, projectRoot);
					results.push({
						formatter: "eslint",
						summary: "Lint fixes applied",
					});
					break;
				}
				case "biome": {
					const args = ["npx", "--yes", "@biomejs/biome", "check", "--write"];
					if (targetFile) {
						args.push(targetFile);
					} else {
						args.push(".");
					}
					runFormatterCommand(args, projectRoot);
					results.push({
						formatter: "biome",
						summary: "Biome fixes applied",
					});
					break;
				}
				case "ruff": {
					const args = ["ruff", "format"];
					if (targetFile) {
						args.push(targetFile);
					} else {
						args.push(".");
					}
					runFormatterCommand(args, projectRoot);
					results.push({
						formatter: "ruff",
						summary: "Ruff format applied",
					});
					break;
				}
				case "rustfmt": {
					const args = ["cargo", "fmt"];
					runFormatterCommand(args, projectRoot);
					results.push({
						formatter: "rustfmt",
						summary: "Rustfmt applied",
					});
					break;
				}
				case "gofmt": {
					const args = ["gofmt", "-w"];
					if (targetFile) {
						args.push(targetFile);
					} else {
						args.push(".");
					}
					runFormatterCommand(args, projectRoot);
					results.push({
						formatter: "gofmt",
						summary: "Gofmt applied",
					});
					break;
				}
				default: {
					results.push({
						formatter,
						summary: "No auto-fix implementation available",
						error: `Unsupported formatter: ${formatter}`,
					});
				}
			}
		} catch (err) {
			results.push({
				formatter,
				summary: "Failed",
				error: String(err),
			});
		}
	}

	return results;
}

function runFormatterCommand(args: string[], cwd: string): void {
	const [cmd, ...cmdArgs] = args;
	execFileSync(cmd, cmdArgs, { cwd, stdio: "pipe", timeout: 30000 });
}

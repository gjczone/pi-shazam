/**
 * pi-shazam tools/find_tests — Test file finder.
 *
 * Locates test files for a given source file or module using common
 * naming conventions (*.test.ts, *.spec.ts, __tests__/ directories).
 */
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { isNonSourceFile } from "../core/filter.js";

export function registerFindTests(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_find_tests",
		label: "Find Test Files",
		description: `\
MUST call to locate test files for a given source file or module.
Returns test file paths, test function names, and coverage hints.
Uses common test naming conventions (*.test.ts, *.spec.ts, __tests__/).

Scenario: before adding tests to verify you found the right file.
Before refactoring a module to know what test coverage exists.
After changing code to locate tests that need updating.`,
		parameters: Type.Object({
			sourceFile: Type.Optional(Type.String()),
			module: Type.Optional(Type.String()),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const sourceFile = params.sourceFile;
			const module = params.module;
			const json = params.json ?? false;
			const graph = scanProject(".");

			const result = executeFindTests(graph, ".", {
				sourceFile,
				module,
			});

			return {
				content: [
					{
						type: "text",
						text: json
							? JSON.stringify(
									{
										schema_version: "1.0",
										command: "find_tests",
										status: "ok",
										result,
									},
									null,
									2,
								)
							: formatFindTestsResult(result, sourceFile, module),
					},
				],
			};
		},
	});
}

interface TestFileMatch {
	testFile: string;
	sourceFile: string;
	type: "direct" | "sibling" | "convention";
	testCount: number;
	tests: string[];
}

interface FindTestsResult {
	matches: TestFileMatch[];
	summary: {
		totalTestFiles: number;
		sourceFiles: number;
	};
}

export function executeFindTests(
	graph: RepoGraph,
	projectRoot: string,
	opts: { sourceFile?: string; module?: string },
): FindTestsResult {
	const matches: TestFileMatch[] = [];
	const allSources = [...graph.fileSymbols.keys()].filter(
		(f) => !isNonSourceFile(f),
	);
	const testPattern = /\.(test|spec|e2e)\.(ts|js|tsx|jsx|mts|mjs)$/;
	const testDirs = ["__tests__", "test", "tests", "__test__"];

	if (opts.sourceFile) {
		const sourceFile = opts.sourceFile;
		const base = basename(sourceFile).replace(
			/\.(ts|js|tsx|jsx|mts|mjs)$/,
			"",
		);
		const dir = dirname(sourceFile);

		for (const f of allSources) {
			if (!testPattern.test(f)) continue;
			const fBase = basename(f).replace(
				/\.(test|spec|e2e)\.(ts|js|tsx|jsx|mts|mjs)$/,
				"",
			);
			if (
				fBase === base &&
				(dirname(f) === dir || dirname(f) === join(dir, "__tests__"))
			) {
				matches.push(
					extractTests(f, sourceFile, "direct", testPattern),
				);
			}
		}

		for (const td of testDirs) {
			const testDir = join(projectRoot, dir, td);
			if (existsSync(testDir)) {
				for (const f of allSources) {
					if (f.startsWith(join(dir, td)) && testPattern.test(f)) {
						if (!matches.some((m) => m.testFile === f)) {
							matches.push(
								extractTests(f, sourceFile, "direct", testPattern),
							);
						}
					}
				}
			}
		}
	}

	if (opts.module) {
		const lower = opts.module.toLowerCase();
		for (const f of allSources) {
			if (!testPattern.test(f)) continue;
			const fLower = f.toLowerCase();
			if (
				fLower.includes(lower) ||
				fLower
					.replace(/[^a-z0-9]/g, "")
					.includes(lower.replace(/[^a-z0-9]/g, ""))
			) {
				if (!matches.some((m) => m.testFile === f)) {
					const sourceFile = f
						.replace(/\.(test|spec|e2e)\./, ".")
						.replace(/_(test|spec|e2e)\./, ".");
					matches.push(
						extractTests(f, sourceFile, "convention", testPattern),
					);
				}
			}
		}
	}

	if (!opts.sourceFile && !opts.module) {
		for (const f of allSources) {
			if (testPattern.test(f)) {
				const sourceFile = f
					.replace(/\.(test|spec|e2e)\./, ".")
					.replace(/_(test|spec|e2e)\./, ".");
				matches.push(
					extractTests(f, sourceFile, "sibling", testPattern),
				);
			}
		}
	}

	return {
		matches,
		summary: {
			totalTestFiles: matches.length,
			sourceFiles: new Set(matches.map((m) => m.sourceFile)).size,
		},
	};
}

function extractTests(
	file: string,
	sourceFile: string,
	type: TestFileMatch["type"],
	_testPattern: RegExp,
): TestFileMatch {
	const tests: string[] = [];
	try {
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const { join } = require("node:path") as typeof import("node:path");
		const content = readFileSync(
			join(require("node:process").cwd(), file),
			"utf-8",
		);
		const testRegex = /(?:(?:it|test|describe)\(['"`])([^'"`]+)/g;
		let m: RegExpExecArray | null;
		while ((m = testRegex.exec(content)) !== null) {
			tests.push(m[1]!);
		}
	} catch {
		// File may not exist in workspace
	}

	return {
		testFile: file,
		sourceFile,
		type,
		testCount: tests.length,
		tests: tests.slice(0, 30),
	};
}

function formatFindTestsResult(
	result: FindTestsResult,
	sourceFile?: string,
	module?: string,
): string {
	const lines: string[] = [];
	lines.push("## Find Tests Result");
	lines.push("");

	if (sourceFile) {
		lines.push(`Source: \`${sourceFile}\``);
	} else if (module) {
		lines.push(`Module: \`${module}\``);
	} else {
		lines.push("All test files in project");
	}
	lines.push("");

	lines.push(`**Test files found: ${result.summary.totalTestFiles}**`);
	lines.push("");

	if (result.matches.length === 0) {
		lines.push("No test files found.");
		lines.push("");
		lines.push("### Next (Recommended)");
		lines.push(
			"- Use `shazam_codesearch --query 'test'` to search for test references",
		);
		lines.push("- Use `shazam_overview` to browse all source files");
		return lines.join("\n");
	}

	for (const match of result.matches) {
		lines.push(`### \`${match.testFile}\``);
		lines.push(`- Type: ${match.type}`);
		lines.push(`- Source: \`${match.sourceFile}\``);
		lines.push(`- Tests: ${match.testCount}`);
		if (match.tests.length > 0) {
			lines.push(
				"  - " + match.tests.slice(0, 10).join("\n  - "),
			);
			if (match.tests.length > 10) {
				lines.push(`  - ... and ${match.tests.length - 10} more`);
			}
		}
		lines.push("");
	}

	lines.push("### Next (Recommended)");
	lines.push("- Run tests with `npx vitest run` or `npm test`");
	lines.push(
		"- Use `shazam_hover --name <testName>` to inspect a test function",
	);
	lines.push(
		"- Use `shazam_file_detail --file <testFile>` to browse test structure",
	);

	return lines.join("\n");
}

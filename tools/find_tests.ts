/**
 * pi-shazam tools/find_tests — Test file finder.
 *
 * Locates test files for a given source file or module using common
 * naming conventions (*.test.ts, *.spec.ts, __tests__/ directories).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { createTool } from "./_factory.js";
import { isNonSourceFile } from "../core/filter.js";
import { getNextForTool, formatNextSection } from "../core/output.js";

export function registerFindTests(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_find_tests",
		label: "Find Test Files",
		description: `\
		When adding tests or modifying source code — use this to discover
		which test files already cover a module, what test functions exist,
		and where new tests belong. Understands *.test.ts, *.spec.ts,
		__tests__/ conventions. Pass sourceFile or module to scope the
		search.`,
		params: Type.Object({
			sourceFile: Type.Optional(Type.String()),
			module: Type.Optional(Type.String()),
		}),
		execute(graph, params) {
			const json = params.json ?? false;
			const sourceFile = params.sourceFile as string | undefined;
			const module = params.module as string | undefined;
			const result = executeFindTests(graph, ".", { sourceFile, module });
			return json
				? JSON.stringify({ schema_version: "1.0", command: "find_tests", status: "ok", result }, null, 2)
				: formatFindTestsResult(result, sourceFile, module);
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
	const allSources = [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));
	const testPattern = /\.(test|spec|e2e)\.(ts|js|tsx|jsx|mts|mjs)$/;
	const testDirs = ["__tests__", "test", "tests", "__test__"];

	if (opts.sourceFile) {
		const sourceFile = opts.sourceFile;
		const base = basename(sourceFile).replace(/\.(ts|js|tsx|jsx|mts|mjs)$/, "");
		const dir = dirname(sourceFile);

		for (const f of allSources) {
			if (!testPattern.test(f)) continue;
			const fBase = basename(f).replace(/\.(test|spec|e2e)\.(ts|js|tsx|jsx|mts|mjs)$/, "");
			if (fBase === base && (dirname(f) === dir || dirname(f) === join(dir, "__tests__"))) {
				matches.push(extractTests(f, sourceFile, "direct", testPattern, projectRoot));
			}
		}

		for (const td of testDirs) {
			const testDir = join(projectRoot, dir, td);
			if (existsSync(testDir)) {
				for (const f of allSources) {
					if (f.startsWith(join(dir, td)) && testPattern.test(f)) {
						if (!matches.some((m) => m.testFile === f)) {
							matches.push(extractTests(f, sourceFile, "direct", testPattern, projectRoot));
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
			if (fLower.includes(lower) || fLower.replace(/[^a-z0-9]/g, "").includes(lower.replace(/[^a-z0-9]/g, ""))) {
				if (!matches.some((m) => m.testFile === f)) {
					const sourceFile = f.replace(/\.(test|spec|e2e)\./, ".").replace(/_(test|spec|e2e)\./, ".");
					matches.push(extractTests(f, sourceFile, "convention", testPattern, projectRoot));
				}
			}
		}
	}

	if (!opts.sourceFile && !opts.module) {
		for (const f of allSources) {
			if (testPattern.test(f)) {
				const sourceFile = f.replace(/\.(test|spec|e2e)\./, ".").replace(/_(test|spec|e2e)\./, ".");
				matches.push(extractTests(f, sourceFile, "sibling", testPattern, projectRoot));
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
	projectRoot: string,
): TestFileMatch {
	const tests: string[] = [];
	try {
		const content = readFileSync(join(projectRoot, file), "utf-8");
		const testRegex = /(?:(?:it|test|describe)\(['"`])([^'"`]+)/g;
		let m: RegExpExecArray | null;
		while ((m = testRegex.exec(content)) !== null) {
			tests.push(m[1]!);
		}
	} catch (err) {
		console.warn("[find_tests] failed to read " + file + ": " + err);
	}

	return {
		testFile: file,
		sourceFile,
		type,
		testCount: tests.length,
		tests: tests.slice(0, 30),
	};
}

export function formatFindTestsResult(result: FindTestsResult, sourceFile?: string, module?: string): string {
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
		const nextItems = getNextForTool("find_tests");
		const nextSection = formatNextSection(nextItems);
		if (nextSection) {
			lines.push("");
			lines.push(nextSection);
		}
		return lines.join("\n");
	}

	for (const match of result.matches) {
		lines.push(`### \`${match.testFile}\``);
		lines.push(`- Type: ${match.type}`);
		lines.push(`- Source: \`${match.sourceFile}\``);
		lines.push(`- Tests: ${match.testCount}`);
		if (match.tests.length > 0) {
			lines.push("  - " + match.tests.slice(0, 10).join("\n  - "));
			if (match.tests.length > 10) {
				lines.push(`  - ... and ${match.tests.length - 10} more`);
			}
		}
		lines.push("");
	}

	const firstTest = result.matches[0]?.tests[0];
	const nextItems = getNextForTool("find_tests", { testFunc: firstTest });
	const nextSection = formatNextSection(nextItems);
	if (nextSection) {
		lines.push("");
		lines.push(nextSection);
	}

	return lines.join("\n");
}

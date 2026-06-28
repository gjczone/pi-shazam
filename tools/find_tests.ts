/**
 * pi-shazam tools/find_tests -- Test file finder.
 *
 * Locates test files for a given source file or module using common
 * naming conventions (*.test.ts, *.spec.ts, __tests__/ directories).
 * Supports Python (test_*.py / *_test.py), Go (*_test.go), Rust
 * (test_*.rs / *_test.rs), Java (Test*.java / *Test.java), and
 * C# (Test*.cs / *Test.cs).
 */
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { RepoGraph } from "../core/graph.js";
import { isNonSourceFile } from "../core/filter.js";
import { _logWarn, getNextForTool, formatNextSection } from "../core/output.js";
import { readFileAdaptive } from "../core/encoding.js";

// Tool registration removed — use `ls tests/*` or `grep -l` instead.

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

function getTestPatternForLanguage(sourceFile: string): RegExp {
	const ext = sourceFile.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "py":
			return /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py)$/;
		case "go":
			return /(?:^|\/)[^/]+_test\.go$/;
		case "rs":
			return /(?:^|\/)(?:test_[^/]+\.rs|[^/]+_test\.rs)$/;
		case "java":
			return /(?:^|\/)(?:Test[^/]+\.java|[^/]+Test\.java)$/;
		case "cs":
			return /(?:^|\/)(?:Test[^/]+\.cs|[^/]+Test\.cs)$/;
		default:
			return /\.(test|spec|e2e)\.(ts|js|tsx|jsx|mts|mjs)$/;
	}
}

export function executeFindTests(
	graph: RepoGraph,
	projectRoot: string,
	opts: { sourceFile?: string; module?: string },
): FindTestsResult {
	const matches: TestFileMatch[] = [];
	const allSources = [...graph.fileSymbols.keys()].filter((f) => !isNonSourceFile(f));
	const testDirs = ["__tests__", "test", "tests", "__test__"];

	if (opts.sourceFile) {
		const sourceFile = opts.sourceFile;
		const base = basename(sourceFile).replace(/\.(ts|js|tsx|jsx|mts|mjs)$/, "");
		const dir = dirname(sourceFile);

		for (const f of allSources) {
			if (!getTestPatternForLanguage(sourceFile).test(f)) continue;
			const fBase = basename(f).replace(/\.(test|spec|e2e)\.(ts|js|tsx|jsx|mts|mjs)$/, "");
			if (fBase === base && (dirname(f) === dir || dirname(f) === join(dir, "__tests__"))) {
				matches.push(extractTests(f, sourceFile, "direct", getTestPatternForLanguage(sourceFile), projectRoot));
			}
		}

		for (const td of testDirs) {
			const testDir = join(projectRoot, dir, td);
			if (existsSync(testDir)) {
				for (const f of allSources) {
					if (f.startsWith(join(dir, td)) && getTestPatternForLanguage(sourceFile).test(f)) {
						if (!matches.some((m) => m.testFile === f)) {
							matches.push(extractTests(f, sourceFile, "direct", getTestPatternForLanguage(sourceFile), projectRoot));
						}
					}
				}
			}
		}

		// Search project-root-level test directories (tests/, test/, __test__/)
		for (const td of testDirs) {
			const testDir = join(projectRoot, td);
			if (!existsSync(testDir)) continue;

			for (const f of allSources) {
				if (!getTestPatternForLanguage(sourceFile).test(f)) continue;
				// Only match files in this specific test directory
				if (!f.startsWith(td + "/") && !f.startsWith(td + "\\")) continue;

				const fBase = basename(f).replace(/\.(test|spec|e2e)\.(ts|js|tsx|jsx|mts|mjs)$/, "");
				if (fBase === base) {
					if (!matches.some((m) => m.testFile === f)) {
						matches.push(extractTests(f, sourceFile, "convention", getTestPatternForLanguage(sourceFile), projectRoot));
					}
				}
			}
		}
	}

	if (opts.module) {
		const lower = opts.module.toLowerCase();
		for (const f of allSources) {
			if (!getTestPatternForLanguage(f).test(f)) continue;
			const fLower = f.toLowerCase();
			if (fLower.includes(lower) || fLower.replace(/[^a-z0-9]/g, "").includes(lower.replace(/[^a-z0-9]/g, ""))) {
				if (!matches.some((m) => m.testFile === f)) {
					const sourceFile = f.replace(/\.(test|spec|e2e)\./, ".").replace(/_(test|spec|e2e)\./, ".");
					matches.push(extractTests(f, sourceFile, "convention", getTestPatternForLanguage(f), projectRoot));
				}
			}
		}
	}

	if (!opts.sourceFile && !opts.module) {
		for (const f of allSources) {
			if (getTestPatternForLanguage(f).test(f)) {
				const sourceFile = f.replace(/\.(test|spec|e2e)\./, ".").replace(/_(test|spec|e2e)\./, ".");
				matches.push(extractTests(f, sourceFile, "sibling", getTestPatternForLanguage(f), projectRoot));
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
		const content = readFileAdaptive(join(projectRoot, file));
		const testRegex = /(?:(?:it|test|describe)\(['"`])([^'"`]+)/g;
		let m: RegExpExecArray | null;
		while ((m = testRegex.exec(content)) !== null) {
			tests.push(m[1]!);
		}
	} catch (err) {
		_logWarn("find_tests", `failed to read ${file}`, err);
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

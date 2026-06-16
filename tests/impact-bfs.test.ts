/**
 * Regression tests for issue #325: BFS deduplication in impact.ts.
 *
 * Verifies that executeImpact (text) and executeImpactJson (JSON) produce
 * consistent affected-file sets for the same input, since both now share
 * the computeImpactBfs() function.
 */
import { describe, it, expect } from "vitest";
import { scanProject } from "../core/scanner.js";
import { executeImpact, executeImpactJson } from "../tools/impact.js";
import type { RepoGraph } from "../core/graph.js";

let _graph: RepoGraph | null = null;
function getGraph(): RepoGraph {
	if (!_graph) {
		_graph = scanProject(".");
	}
	return _graph;
}

/**
 * Extract affected file paths from the text output of executeImpact.
 * Parses lines like "- `path/to/file.ts`" or "#### `path/to/file.ts`"
 * from the "Affected Files & Symbols" section.
 */
function extractAffectedFilesFromText(text: string): Set<string> {
	const files = new Set<string>();
	const lines = text.split("\n");
	let inAffectedSection = false;
	for (const line of lines) {
		if (line.startsWith("### Affected Files & Symbols")) {
			inAffectedSection = true;
			continue;
		}
		if (inAffectedSection && line.startsWith("### ")) {
			break;
		}
		if (inAffectedSection) {
			// Match "- `file`" or "#### `file`"
			const match = line.match(/[-#]+ `([^`]+)`/);
			if (match) {
				files.add(match[1]);
			}
		}
	}
	return files;
}

/**
 * Extract affected file list from the JSON output of executeImpactJson.
 */
function extractAffectedFilesFromJson(jsonStr: string): Set<string> {
	const parsed = JSON.parse(jsonStr);
	return new Set(parsed.result.affectedFiles as string[]);
}

describe("Issue #325: Impact BFS deduplication", () => {
	it("text and JSON outputs produce identical affected-file sets for index.ts", () => {
		const graph = getGraph();
		const files = ["index.ts"];

		const textOutput = executeImpact(graph, files);
		const jsonOutput = executeImpactJson(graph, files);

		const textFiles = extractAffectedFilesFromText(textOutput);
		const jsonFiles = extractAffectedFilesFromJson(jsonOutput);

		// Both outputs should agree on the affected file set
		expect([...textFiles].sort()).toEqual([...jsonFiles].sort());
	});

	it("text and JSON outputs produce identical affected-file sets for core/graph.ts", () => {
		const graph = getGraph();
		const files = ["core/graph.ts"];

		const textOutput = executeImpact(graph, files);
		const jsonOutput = executeImpactJson(graph, files);

		const textFiles = extractAffectedFilesFromText(textOutput);
		const jsonFiles = extractAffectedFilesFromJson(jsonOutput);

		expect([...textFiles].sort()).toEqual([...jsonFiles].sort());
	});

	it("text and JSON outputs produce identical affected-file sets for multiple files", () => {
		const graph = getGraph();
		const files = ["core/graph.ts", "core/pagerank.ts"];

		const textOutput = executeImpact(graph, files);
		const jsonOutput = executeImpactJson(graph, files);

		const textFiles = extractAffectedFilesFromText(textOutput);
		const jsonFiles = extractAffectedFilesFromJson(jsonOutput);

		expect([...textFiles].sort()).toEqual([...jsonFiles].sort());
	});

	it("JSON envelope affectedFileCount matches affectedFiles array length", () => {
		const graph = getGraph();
		const files = ["index.ts"];

		const jsonOutput = executeImpactJson(graph, files);
		const parsed = JSON.parse(jsonOutput);

		expect(parsed.result.affectedFileCount).toBe(parsed.result.affectedFiles.length);
	});

	it("text output Affected files count matches JSON affectedFileCount", () => {
		const graph = getGraph();
		const files = ["index.ts"];

		const textOutput = executeImpact(graph, files);
		const jsonOutput = executeImpactJson(graph, files);
		const parsed = JSON.parse(jsonOutput);

		const textCountMatch = textOutput.match(/Affected files: (\d+)/);
		expect(textCountMatch).not.toBeNull();
		const textCount = parseInt(textCountMatch![1], 10);

		expect(textCount).toBe(parsed.result.affectedFileCount);
	});
});

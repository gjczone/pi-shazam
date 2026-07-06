/**
 * Tests for issue #631 B (slice 3.5): shazam_changes exposes a
 * `structuralChanges` field summarizing added / removed / modified
 * line counts across the working-tree changes.
 *
 * Computed from `git diff --numstat` for the changed files. When
 * there are too many changed files the field is undefined (we cap
 * the per-file numstat at 20 files to keep the command fast).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../core/scanner.js";
import { buildChangesResult, executeChangesJson, renderChangesMarkdown } from "../tools/changes.js";
import { createRepoGraph, type RepoGraph } from "../core/graph.js";

let tmpDir: string;
let _graph: RepoGraph | null = null;

function getGraph(): RepoGraph {
	if (!_graph) {
		_graph = scanProject(tmpDir);
	}
	return _graph;
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "shazam-changes-structural-"));
	// Initialize a fresh git repo with a baseline commit so we have
	// a stable "from" state to diff against.
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmpDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
	mkdirSync(join(tmpDir, "src"));
	writeFileSync(
		join(tmpDir, "src", "a.ts"),
		"export function a() {\n  return 'a';\n}\n\nexport function b() {\n  return 'b';\n}\n",
	);
	execFileSync("git", ["add", "-A"], { cwd: tmpDir });
	execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: tmpDir });

	// Add 5 lines and remove 2 lines in a.ts to produce a non-zero
	// numstat signature.
	const grown = [
		"export function a() {",
		"  return 'a';",
		"}",
		"",
		"export function b() {",
		"  return 'b';",
		"}",
		"",
		"export function c() {",
		"  return 'c';",
		"}",
		"",
	].join("\n");
	writeFileSync(join(tmpDir, "src", "a.ts"), grown);
});

afterAll(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ok */
	}
});

describe("shazam_changes structuralChanges field (issue #631 B)", () => {
	it("buildChangesResult attaches a structuralChanges summary when changes exist", () => {
		const graph = getGraph();
		const result = buildChangesResult(graph, tmpDir);
		expect(result.structuralChanges).toBeDefined();
		// The fixture added 5 lines and removed 0 lines (we replaced
		// the file in full). The numstat will report the diff:
		// - added: 9, removed: 7 (we replaced an 8-line file with a 12-line one).
		expect(result.structuralChanges!.added).toBeGreaterThan(0);
		expect(result.structuralChanges!.modified).toBe(1);
	});

	it("executeChangesJson surfaces structuralChanges in the JSON envelope", () => {
		const graph = getGraph();
		const envelope = executeChangesJson(graph, tmpDir);
		const parsed = JSON.parse(envelope);
		expect(parsed.status).toBe("ok");
		expect(parsed.result.structuralChanges).toBeDefined();
		expect(parsed.result.structuralChanges.added).toBeGreaterThan(0);
	});

	it("structuralChanges is undefined when there are no changed files", () => {
		// Use a clean tmp dir with no working-tree changes.
		const cleanDir = mkdtempSync(join(tmpdir(), "shazam-changes-clean-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: cleanDir });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: cleanDir });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: cleanDir });
			mkdirSync(join(cleanDir, "src"));
			writeFileSync(join(cleanDir, "src", "x.ts"), "export const x = 1;\n");
			execFileSync("git", ["add", "-A"], { cwd: cleanDir });
			execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: cleanDir });

			const graph = scanProject(cleanDir);
			const result = buildChangesResult(graph, cleanDir);
			expect(result.gitChangedFiles.length).toBe(0);
			expect(result.structuralChanges).toBeUndefined();
		} finally {
			try {
				rmSync(cleanDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("renderChangesMarkdown includes a line-count summary when structuralChanges is set", () => {
		const graph = getGraph();
		const result = buildChangesResult(graph, tmpDir);
		expect(result.structuralChanges).toBeDefined();
		const text = renderChangesMarkdown(result);
		// Markdown output should mention the added/removed line counts.
		expect(text).toMatch(/\+\d+.*lines across/);
	});

	it("structuralChanges counts every changed file when there are <= 20", () => {
		const graph = getGraph();
		const result = buildChangesResult(graph, tmpDir);
		expect(result.structuralChanges).toBeDefined();
		// Only one file changed in the fixture, so modified === 1.
		expect(result.structuralChanges!.modified).toBe(1);
		expect(result.structuralChanges!.added + result.structuralChanges!.removed).toBeGreaterThan(0);
	});

	it("structuralChanges is undefined for a non-git directory", () => {
		// Create a tmp dir without git and a fake file. The scanner
		// needs a RepoGraph to be returned, so build a minimal one.
		const nonGitDir = mkdtempSync(join(tmpdir(), "shazam-changes-nongit-"));
		try {
			const graph = createRepoGraph();
			const result = buildChangesResult(graph, nonGitDir);
			expect(result.gitChangedFiles.length).toBe(0);
			expect(result.structuralChanges).toBeUndefined();
		} finally {
			try {
				rmSync(nonGitDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});
});

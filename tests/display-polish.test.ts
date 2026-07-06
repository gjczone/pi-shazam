/**
 * Regression tests for issue #634: three small display issues.
 *
 * 1. `shazam_verify` counter used to lump "Total" with errors+warnings but
 *    count ALL severities (error + warning + info + hint). Fix: split into
 *    Errors | Warnings | Info | Hint.
 * 2. `shazam_overview` Module Structure used to print "1 files" (wrong
 *    plural) and a trailing "/" on the label. Fix: singular "file" for
 *    count === 1, drop the trailing slash.
 * 3. `shazam_changes` used to emit 6 lines on a clean tree. Fix: compact
 *    3-line output when no git changes AND no orphan risk.
 */
import { describe, it, expect } from "vitest";
import { scanProject } from "../core/scanner.js";
import { executeOverview } from "../tools/overview.js";
import { executeChanges } from "../tools/changes.js";
import { createRepoGraph } from "../core/graph.js";
import type { RepoGraph } from "../core/graph.js";

let _graph: RepoGraph | null = null;
function getGraph(): RepoGraph {
	if (!_graph) _graph = scanProject(".");
	return _graph;
}

describe("issue #634 / 1: shazam_verify counter breakdown", () => {
	it("verify counter text matches the new 4-bucket format", async () => {
		// Import dynamically to avoid pulling LSP into the cold test path.
		const { executeVerifyTextAsync } = await import("../tools/verify.js");
		const text = await executeVerifyTextAsync(process.cwd(), { quick: true });

		// The old format `Total: N` must NOT appear (only the new 4-bucket form).
		expect(text).not.toMatch(/Total: \d+/);
		const summaryMatch = text.match(/^Errors: \d+ \| Warnings: \d+ \| Info: \d+ \| Hint: \d+$/m);
		if (text.includes("Errors:")) {
			expect(summaryMatch).not.toBeNull();
		}
	});
});

describe("issue #634 / 2: shazam_overview plural agreement + no trailing slash", () => {
	it("uses 'file' (singular) when a directory has exactly 1 file", () => {
		const graph = getGraph();
		const overview = executeOverview(graph, ".");

		// Pull every "- `dir` - N file(s)" line.
		const lines = overview.split("\n");
		const entries = lines.filter((l) => /^- `[^`]+` - \d+ files?$/.test(l));

		for (const line of entries) {
			const m = line.match(/- `([^`]+)` - (\d+) files?$/);
			expect(m).not.toBeNull();
			if (!m) continue;
			const count = parseInt(m[2], 10);
			const word = m[0].match(/files?$/)![0];
			// Plural agreement: 1 -> "file", !=1 -> "files".
			if (count === 1) {
				expect(word).toBe("file");
			} else {
				expect(word).toBe("files");
			}
		}
	});

	it("never appends a trailing slash to directory labels", () => {
		const graph = getGraph();
		const overview = executeOverview(graph, ".");

		// Old bug: `- \`core/foo/\` - 3 files`. New: `- \`core/foo\` - 3 files`.
		expect(overview).not.toMatch(/^- `[^`]+\/` -/m);
	});
});

describe("issue #634 / 3: shazam_changes compact output on clean tree", () => {
	it("emits at most 4 lines when there are no changes and no orphans", async () => {
		// Use a fresh tmp dir with its own git repo so git reports no
		// changes (otherwise the parent project's working tree leaks
		// in via `git rev-parse --show-toplevel`). An empty graph
		// guarantees `findOrphans` returns zero. Both conditions
		// trigger the compact 3-line branch in executeChanges.
		const { mkdirSync, rmSync } = require("node:fs");
		const { execFileSync } = require("node:child_process");
		const { join } = require("node:path");
		const tmpDir = join(process.cwd(), ".shazam-test-clean-tree");
		mkdirSync(tmpDir, { recursive: true });
		try {
			// Initialise a clean, detached git repo inside the tmp dir so
			// `resolveGitWorkdir` resolves to it, not to the outer repo.
			execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir });
			execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
				cwd: tmpDir,
			});

			const emptyGraph = createRepoGraph();
			const output = executeChanges(emptyGraph, tmpDir);

			const lines = output.split("\n");
			// Compact path keeps the `## Change Summary` header so parity
			// tests / downstream parsers can detect the section. The
			// shortcut is the absence of all the other section headers
			// (Risk Level, Git Working Tree Changes, etc.) -- only the
			// "No uncommitted changes" summary line is emitted.
			expect(lines.length).toBeLessThanOrEqual(4);
			expect(output).toMatch(/## Change Summary/);
			expect(output).toMatch(/No uncommitted changes\. Risk: /);
			expect(output).not.toMatch(/### Risk Level/);
			expect(output).not.toMatch(/### Git Working Tree Changes/);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

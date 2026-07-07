/**
 * Tests for issue #658: shazam_format JSON mode never applied fixes. The
 * JSON executor wrapped buildFormatResult verbatim, which only analyzed and
 * never called runFormatters, so a JSON agent calling with dryRun:false got
 * a success-shaped result while nothing was written.
 *
 * The fix makes buildFormatResult mirror the text path: when !dryRun it
 * calls runFormatters and populates formatResults + recommendedCommands.
 */
import { describe, it, expect } from "vitest";
import { createRepoGraph } from "../core/graph.js";
import { buildFormatResult } from "../tools/format.js";
import type { RepoGraph } from "../core/graph.js";

describe("issue #658: shazam_format JSON mode applies fixes when dryRun:false", () => {
	it("does NOT apply and omits apply fields in dry-run mode", async () => {
		const graph: RepoGraph = createRepoGraph();
		const result = await buildFormatResult(graph, process.cwd(), { dryRun: true });
		expect(result.dryRun).toBe(true);
		expect(result.formatResults).toBeUndefined();
		expect(result.recommendedCommands).toBeUndefined();
	});

	it("applies fixes and reports outcomes when dryRun:false", async () => {
		const graph: RepoGraph = createRepoGraph();
		const result = await buildFormatResult(graph, process.cwd(), { dryRun: false });
		expect(result.dryRun).toBe(false);
		// The apply branch must have run runFormatters and populated the field.
		expect(Array.isArray(result.formatResults)).toBe(true);
		// recommendedCommands is always emitted in apply mode (may be empty if
		// no formatters detected, but the field must exist).
		expect(Array.isArray(result.recommendedCommands)).toBe(true);
	});
});

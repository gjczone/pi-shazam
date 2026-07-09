/**
 * tests/verify-comment-label.test.ts
 *
 * #698: formatVerifyComment must emit the `(verify)` label (not `(mcp)`)
 * for critical paths whose incomingCallers fall in the 1-9 range.
 */
import { describe, it, expect } from "vitest";
import { formatVerifyComment, type VerifyCommentInput } from "../tools/verify-comment.js";

function makeResult(): VerifyCommentInput {
	return {
		schema_version: "1.0",
		command: "verify",
		project: "/workspace/example",
		status: "ok",
		result: {
			symbolCount: 1,
			fileCount: 1,
			edgeCount: 1,
			riskLevel: "low",
			riskReason: "fixture",
			orphanCount: 0,
			internalOrphanCount: 0,
			exportedOrphanCount: 0,
			gitChangedFiles: [],
			baselineDiff: null,
			lspDiagnostics: [],
			lspAvailable: true,
			verdict: "PASS",
			quickMode: false,
			lspOnlyMode: false,
			preCommitMode: false,
		},
	};
}

describe("formatVerifyComment critical path label (#698)", () => {
	it("uses (verify) label for incomingCallers in 1-9 range, never (mcp)", () => {
		const input = makeResult();
		input.criticalPaths = [{ symbol: "getGraph", incomingCallers: 2 }];

		const md = formatVerifyComment(input);

		expect(md).toContain("### Affected Critical Paths");
		expect(md).toContain("- `getGraph` (verify) — 2 incoming callers");
		expect(md).not.toContain("(mcp)");
	});
});

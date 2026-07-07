/**
 * post-comment.mjs — Format shazam_verify JSON result → markdown comment
 *
 * #638: GitHub Action wrapper for shazam_verify
 *
 * Usage: node post-comment.mjs <result-json-path>
 *
 * Reads the result JSON, formats it using formatVerifyComment,
 * and outputs the markdown to stdout.
 *
 * post-comment.sh then:
 * - Writes the markdown to GITHUB_STEP_SUMMARY
 * - Posts via `gh pr comment --body-file`
 * - Exits non-zero if fail-on-verdict=true and verdict=FAIL
 */
import { readFileSync } from "node:fs";

const resultPath = process.argv[2];

const raw = readFileSync(resultPath, "utf-8");
const envelope = JSON.parse(raw);

// Import formatVerifyComment from the action repo's built dist
// (this runs inside the pi-shazam repo itself)
const distDir = process.env.GITHUB_WORKSPACE + "/dist";

async function main() {
	const commentModule = await import(`${distDir}/tools/verify-comment.js`);
	const { formatVerifyComment } = commentModule;

	const md = formatVerifyComment(envelope);
	process.stdout.write(md);
}

main().catch((err) => {
	// Fallback: if formatVerifyComment import fails, generate a simple comment
	console.error("formatVerifyComment import failed, using fallback:", err.message);
	const { result, criticalPaths } = envelope;

	const lines = [
		`## shazam_verify — pi-shazam`,
		"",
		`**Verdict**: ${result.verdict}`,
		`**Risk**: ${result.riskLevel}`,
		`**Errors**: ${result.lspDiagnostics.filter((d) => d.severity === "error").length} | **Warnings**: ${result.lspDiagnostics.filter((d) => d.severity === "warning").length} | **Info**: ${result.lspDiagnostics.filter((d) => d.severity === "info").length}`,
		`**Edges**: ${result.edgeCount} | **Symbols**: ${result.symbolCount} | **Files**: ${result.fileCount}`,
		"",
		"---",
		"Full report: artifact `shazam-verify-report` attached to this run.",
	];

	process.stdout.write(lines.join("\n"));
});

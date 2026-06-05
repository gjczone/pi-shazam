/**
 * pi-shazam tools/ready — Pre-commit readiness check.
 *
 * Composes verify + check into a single pre-commit gate.
 * This is the FINAL GATE before shipping code.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { executeVerifyJson } from "./verify.js";
import { executeCheckJson } from "./check.js";

// Avoid circular imports by referencing JSON outputs and parsing them
interface VerifyResult {
	result?: {
		riskLevel: string;
		orphanCount: number;
		symbolCount: number;
		fileCount: number;
	};
}

interface CheckResult {
	result?: {
		parsedFiles: number;
		failedFiles: number;
		symbolCount: number;
	};
}

export function registerReady(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shazam_ready",
		label: "Pre-Commit Readiness",
		description: `\
MUST call before committing, pushing, or calling goal_complete. Runs
verify + check + fix in sequence. This is the FINAL GATE — the last
thing you do before shipping code. If ready fails, you are NOT DONE.
Fix all issues and call ready again until it passes with zero errors.

Scenario: about to git commit. About to push. About to open a PR.
About to call goal_complete. Before merging to main.`,
		parameters: Type.Object({
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const json = params.json ?? false;
			const graph = scanProject(".");

			if (json) {
				return {
					content: [
						{
							type: "text",
							text: executeReadyJson(graph, "."),
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: executeReady(graph, "."),
					},
				],
			};
		},
	});
}

// ── Execute functions (testable without Pi) ────────────────────────────────

/**
 * Run pre-commit readiness check, composing verify + check results.
 */
export function executeReady(graph: RepoGraph, projectRoot: string): string {
	const verifyJsonRaw = executeVerifyJson(graph, projectRoot);
	const checkJsonRaw = executeCheckJson(graph, projectRoot);

	let verifyData: VerifyResult = {};
	let checkData: CheckResult = {};

	try {
		verifyData = JSON.parse(verifyJsonRaw) as VerifyResult;
	} catch { /* use defaults */ }

	try {
		checkData = JSON.parse(checkJsonRaw) as CheckResult;
	} catch { /* use defaults */ }

	const riskLevel = verifyData.result?.riskLevel ?? "unknown";
	const orphanCount = verifyData.result?.orphanCount ?? 0;
	const failedFiles = checkData.result?.failedFiles ?? 0;
	const parsedFiles = checkData.result?.parsedFiles ?? 0;

	const isReady = riskLevel === "low" && orphanCount === 0 && failedFiles === 0;

	const lines: string[] = [];
	lines.push("## Pre-Commit Readiness");
	lines.push("");

	// ── Status ──────────────────────────────────────────────────────────
	lines.push(`**Status:** ${isReady ? "[PASS] READY" : "[FAIL] NOT READY"}`);
	lines.push("");

	// ── Verify summary ──────────────────────────────────────────────────
	lines.push("### Verify");
	lines.push(`Risk level: **${riskLevel}**`);
	lines.push(`Orphan symbols: ${orphanCount}`);
	lines.push(`Total symbols: ${verifyData.result?.symbolCount ?? "?"}`);
	lines.push(`Total files: ${verifyData.result?.fileCount ?? "?"}`);
	lines.push("");

	// ── Check summary ──────────────────────────────────────────────────
	lines.push("### Check");
	lines.push(`Files parsed: ${parsedFiles}`);
	lines.push(`Files failed: ${failedFiles}`);
	lines.push("");

	// ── Recommendations ────────────────────────────────────────────────
	if (!isReady) {
		lines.push("### Issues to Fix Before Commit");
		lines.push("");
		if (riskLevel !== "low") {
			lines.push(`- Risk level is **${riskLevel}** — run \`shazam_verify\` for details`);
		}
		if (orphanCount > 0) {
			lines.push(`- ${orphanCount} orphan symbol(s) — run \`shazam_orphan\` to review`);
		}
		if (failedFiles > 0) {
			lines.push(`- ${failedFiles} file(s) failed parse — run \`shazam_check\` for details`);
		}
		lines.push("");
		lines.push("Run `shazam_fix` to auto-fix format issues, then call `shazam_ready` again.");
	} else {
		lines.push("All checks pass. Ready to commit! 🚀");
	}

	return lines.join("\n");
}

/**
 * Run readiness check and return structured JSON.
 */
export function executeReadyJson(
	graph: RepoGraph,
	projectRoot: string,
): string {
	const verifyJsonRaw = executeVerifyJson(graph, projectRoot);
	const checkJsonRaw = executeCheckJson(graph, projectRoot);

	let verifyData: VerifyResult = {};
	let checkData: CheckResult = {};

	try {
		verifyData = JSON.parse(verifyJsonRaw) as VerifyResult;
	} catch { /* use defaults */ }

	try {
		checkData = JSON.parse(checkJsonRaw) as CheckResult;
	} catch { /* use defaults */ }

	const riskLevel = verifyData.result?.riskLevel ?? "unknown";
	const orphanCount = verifyData.result?.orphanCount ?? 0;
	const failedFiles = checkData.result?.failedFiles ?? 0;
	const isReady = riskLevel === "low" && orphanCount === 0 && failedFiles === 0;

	return JSON.stringify({
		schema_version: "1.0",
		command: "ready",
		project: projectRoot,
		status: "ok",
		result: {
			ready: isReady,
			verify: {
				riskLevel,
				orphanCount,
				symbolCount: verifyData.result?.symbolCount ?? 0,
				fileCount: verifyData.result?.fileCount ?? 0,
			},
			check: {
				parsedFiles: checkData.result?.parsedFiles ?? 0,
				failedFiles,
				symbolCount: checkData.result?.symbolCount ?? 0,
			},
		},
	});
}

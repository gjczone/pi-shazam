/**
 * pi-shazam hooks/after-write — Auto-verify after write/edit operations.
 *
 * Registered on the `tool_result` event. When the LLM writes or edits a file,
 * this hook automatically runs diagnostics and sends findings back to the
 * conversation.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { scanProject } from "../core/scanner.js";

/** Tool names that trigger auto-verify */
const WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * Determine if a tool result should trigger automatic verification.
 *
 * @param toolName - Name of the tool that was executed
 * @param isError - Whether the tool execution resulted in an error
 * @returns true if verification should run
 */
export function shouldTriggerVerify(toolName: string, isError: boolean): boolean {
	return WRITE_TOOLS.has(toolName) && !isError;
}

/**
 * Handle a write/edit tool result by running diagnostics and reporting findings.
 *
 * @param toolName - The tool that was executed (write or edit)
 * @param projectRoot - Project root directory
 * @returns Diagnostic findings as a formatted text string
 */
export function handleWriteResult(
	toolName: string,
	projectRoot: string,
): string {
	try {
		// Re-scan project to detect changes
		const graph = scanProject(projectRoot, () => {});

		const lines: string[] = [];
		lines.push(`[pi-shazam] Auto-verify after ${toolName}:`);
		lines.push("");

		// Summary stats
		lines.push(
			`- Project has ${graph.symbols.size} symbols across ${graph.fileSymbols.size} files`,
		);

		// Check for orphan symbols (symbols with no incoming edges)
		const orphanCount = [...graph.symbols.values()].filter((sym) => {
			const incoming = graph.incoming.get(sym.id);
			return !incoming || incoming.length === 0;
		}).length;

		if (orphanCount > 0) {
			lines.push(
				`- ⚠️  Found ${orphanCount} symbols with no incoming references (potential orphans)`,
			);
		} else {
			lines.push("- ✅ No orphan symbols detected");
		}

		// Report on changed files (files with symbols but no imports from other files)
		const fileCount = graph.fileSymbols.size;
		const importCount = graph.fileImports.size;
		lines.push(`- ${importCount}/${fileCount} files have import relationships`);

		return lines.join("\n");
	} catch (err) {
		return `[pi-shazam] Auto-verify failed: ${err}`;
	}
}

/**
 * Register the after-write hook on the Pi extension API.
 *
 * On `tool_result` for write/edit operations, runs diagnostics and sends
 * findings via pi.sendMessage().
 */
export function registerAfterWriteHook(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, _ctx) => {
		try {
			// Skip non-write tools and errors
			if (!shouldTriggerVerify(event.toolName, event.isError)) {
				return;
			}

			const findings = handleWriteResult(event.toolName, ".");

			// Send findings as a message to the LLM
			pi.sendMessage({
				customType: "shazam-auto-verify",
				content: [{ type: "text", text: findings }],
				display: true,
			});
		} catch (err) {
			pi.logger.warn(`[pi-shazam] Auto-verify hook error: ${err}`);
		}
	});
}

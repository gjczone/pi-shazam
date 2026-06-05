/**
 * pi-shazam hooks/before-start — Inject project overview into system prompt.
 *
 * Registered on the `before_agent_start` event. Scans the project with
 * tree-sitter, generates an overview, and injects it into the system prompt
 * so the LLM has structural awareness before reading any code.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { scanProject } from "../core/scanner.js";
import { executeOverview } from "../tools/overview.js";

/**
 * Generate a project overview string suitable for system prompt injection.
 *
 * @param projectRoot - Absolute or relative path to the project root
 * @returns A formatted overview string prefixed with [pi-shazam] tag
 */
export function generateOverviewForPrompt(projectRoot: string): string {
	const graph = scanProject(projectRoot, () => {});
	const overview = executeOverview(graph, projectRoot);
	return `[pi-shazam] Project Overview:\n${overview}`;
}

/**
 * Register the before-start hook on the Pi extension API.
 *
 * On `before_agent_start`, generates a project overview and injects it
 * into the system prompt array.
 */
export function registerBeforeStartHook(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, _ctx) => {
		try {
			const overviewText = generateOverviewForPrompt(".");
			// Append overview to the system prompt
			return {
				systemPrompt: [overviewText],
			};
		} catch (err) {
			pi.logger.warn(`[pi-shazam] Failed to generate overview: ${err}`);
			// Don't block agent start on overview failure
			return undefined;
		}
	});
}

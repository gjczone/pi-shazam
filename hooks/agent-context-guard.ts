/**
 * pi-shazam hooks/agent-context-guard -- Agent prompt structural context checker.
 *
 * Intercepts agent-like tool calls (agent, agent_swarm, subagent) and checks
 * whether the prompt contains sufficient structural context for the task type.
 *
 * For review/audit tasks: blocks if context score is below threshold.
 * For coding tasks: warns (non-blocking) if context is insufficient.
 * Short prompts (< 30 words) are always skipped.
 */

import type { ExtensionAPI, ToolCallEventResult } from "../types/pi-extension.js";

/**
 * Tool names that represent agent spawning (case-insensitive check).
 */
const AGENT_TOOL_NAMES = new Set(["agent", "agent_swarm", "subagent"]);

/**
 * Patterns that indicate a review/audit task.
 */
const REVIEW_PATTERNS = /review|audit|security|integrity/i;

/**
 * Patterns that indicate a coding/implementation task.
 */
const CODING_PATTERNS = /implement|write|edit|create|fix|refactor/i;

/**
 * Minimum word count for a prompt to be evaluated.
 * Short prompts are typically simple queries that don't need context checks.
 */
const MIN_WORD_COUNT = 30;

/**
 * Minimum context score for review tasks to proceed.
 */
const REVIEW_CONTEXT_THRESHOLD = 2;

/**
 * Minimum context score for coding tasks (below this triggers a warning).
 */
const CODING_CONTEXT_THRESHOLD = 1;

/**
 * Compute a structural context score for a prompt.
 * Each detected context marker adds 1 point:
 *   - File paths: must contain a path with a recognized source-code extension
 *   - Symbol references: backtick-wrapped identifiers (e.g., `MyClass`)
 *   - File:line references: combined file-path + line number (e.g., src/foo.ts:42)
 *   - shazam_ tool references
 *
 * Standalone line numbers (e.g., "line 42" or ":42") no longer count --
 * they are trivially gamed and do not provide structural context.
 */
function computeContextScore(prompt: string): number {
	// File paths: at least one `/` component + recognized code extension
	const hasFilePaths =
		/(?:\/[\w.-]+|[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+)\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|cs|rb|swift|kt|kts|c|cpp|cc|cxx|h|hpp|hh|hxx|vue|svelte|css|scss|less|html|json|ya?ml|md|toml|xml|sql|sh|bash|proto|graphql|prisma)\b/i.test(
			prompt,
		);
	// Symbol references: backtick-wrapped content with at least one non-whitespace char
	const hasSymbols = /`[^`\s]+`/.test(prompt);
	// File:line combos (e.g., foo.ts:42, src/bar.py:120-125)
	const hasPathLine = /[\w.-]+\.[a-z]{1,8}:\d+([-–]\d+)?\b/i.test(prompt);
	// shazam_ tool references
	const hasShazam = /shazam_/i.test(prompt);
	return [hasFilePaths, hasSymbols, hasPathLine, hasShazam].filter(Boolean).length;
}

/**
 * Register the agent context guard hook.
 *
 * Blocks review tasks that lack structural context and warns on
 * coding tasks with insufficient context.
 * When shazam_ tools are already referenced in the prompt,
 * the review threshold is lowered to 1 and self-referential
 * prompts (prompts that are about shazam itself) are allowed.
 */
export function registerAgentContextGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx): ToolCallEventResult | void => {
		const toolName = event.toolName.toLowerCase();
		if (!AGENT_TOOL_NAMES.has(toolName)) return;

		const input = event.input;
		// input is optional (input?: unknown). Guard before the cast so a
		// tool_call event with a missing/null input payload is skipped instead
		// of crashing the hook handler with a TypeError (#472). Mirrors the
		// guard pattern used by sibling hooks (pre-edit.ts, _bash-utils.ts).
		if (!input || typeof input !== "object") return;
		const prompt = (input as Record<string, unknown>).prompt as string;
		if (!prompt) return;

		// Skip trivial prompts
		const wordCount = prompt.trim().split(/\s+/).length;
		if (wordCount < MIN_WORD_COUNT) return;

		const isReview = REVIEW_PATTERNS.test(prompt);
		const isCoding = CODING_PATTERNS.test(prompt);
		const contextScore = computeContextScore(prompt);
		const hasShazam = /shazam_/i.test(prompt);

		// When prompt already references shazam tools, lower review threshold to 1
		const reviewThreshold = hasShazam ? 1 : REVIEW_CONTEXT_THRESHOLD;

		// Allow self-referential prompts (prompts about shazam itself)
		const isSelfReferential = hasShazam && /pi-shazam|shazam_\w+/i.test(prompt);
		if (isSelfReferential) return;

		// Block review tasks without sufficient context
		if (isReview && contextScore < reviewThreshold) {
			return {
				block: true,
				reason:
					"Review task lacks structural context. Provide file paths and symbols from shazam_lookup or shazam_impact first.",
			};
		}

		// Warn coding tasks without context (non-blocking)
		if (isCoding && contextScore < CODING_CONTEXT_THRESHOLD) {
			ctx.ui?.notify?.(
				"[shazam] Coding task lacks structural context. Consider running shazam_overview or shazam_lookup first for better results.",
				"warning",
			);
		}
	});
}

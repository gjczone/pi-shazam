/**
 * pi-shazam hooks/_bash-utils — Shared bash command utilities.
 *
 * Extracted from hooks/safety.ts and hooks/issue-guard.ts to eliminate
 * duplication. Provides command tokenization (with bash quote/escape
 * semantics) and safe event input extraction.
 */

/**
 * Tokenize a bash command string into argv, respecting quotes.
 *
 * Handles:
 *   - Single quotes: literal content, no escape processing
 *   - Double quotes: backslash escapes (\" becomes ")
 *   - Bash single-quote escape pattern: '\'' produces a literal '
 *     (e.g., "it'\''s" -> "it's")
 *   - Unquoted backslash escapes: \X becomes X
 *   - Whitespace as token separator
 */
export function tokenizeCommand(cmd: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < cmd.length) {
		// Skip whitespace between tokens
		while (i < cmd.length && /\s/.test(cmd[i]!)) i++;
		if (i >= cmd.length) break;

		if (cmd[i] === "'" || cmd[i] === '"') {
			const quote = cmd[i]!;
			i++;
			let token = "";
			while (i < cmd.length) {
				if (cmd[i] === quote) {
					// Check for bash '\'' escape pattern (single-quote only):
					// close-quote, backslash, single-quote, open-quote
					// e.g., "it'\''s" -> "it's"
					if (quote === "'" && i + 3 < cmd.length && cmd[i + 1] === "\\" && cmd[i + 2] === "'" && cmd[i + 3] === "'") {
						token += "'";
						i += 4; // skip: ' \ ' '
						continue;
					}
					i++; // skip closing quote
					break;
				}
				if (quote === '"' && cmd[i] === "\\" && i + 1 < cmd.length) {
					i++; // skip backslash inside double quotes
				}
				token += cmd[i];
				i++;
			}
			tokens.push(token);
		} else {
			let token = "";
			while (i < cmd.length && !/\s/.test(cmd[i]!)) {
				if (cmd[i] === "\\" && i + 1 < cmd.length) {
					i++; // skip backslash, take next char literally
				}
				token += cmd[i];
				i++;
			}
			tokens.push(token);
		}
	}
	return tokens;
}

/**
 * Safely extract the `command` field from a tool_call event's input.
 *
 * Pi tool_call events carry `event.input.command` for bash tools.
 * This helper performs type narrowing to avoid unsafe casts.
 * Returns empty string when the event shape does not match.
 */
export function extractCommandFromEvent(event: unknown): string {
	if (typeof event !== "object" || event === null) return "";
	const input = (event as Record<string, unknown>).input;
	if (typeof input !== "object" || input === null) return "";
	const command = (input as Record<string, unknown>).command;
	return typeof command === "string" ? command : "";
}

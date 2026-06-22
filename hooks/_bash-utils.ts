/**
 * pi-shazam hooks/_bash-utils — Shared bash command utilities.
 *
 * Extracted from hooks/safety.ts and hooks/issue-guard.ts to eliminate
 * duplication. Provides command tokenization (with bash quote/escape
 * semantics, command-substitution awareness, and pipe/separator splitting)
 * and safe event input extraction.
 */

/* ─── internal helpers ──────────────────────────────────────────── */

/**
 * Skip past a quoted string, returning the index AFTER the closing quote.
 * Handles backslash escapes inside double quotes.
 * Unterminated quotes: returns cmd.length.
 */
function _skipQuoted(cmd: string, start: number): number {
	const quote = cmd[start]!;
	let i = start + 1;
	while (i < cmd.length) {
		if (quote === '"' && cmd[i] === "\\" && i + 1 < cmd.length) {
			i += 2; // skip backslash-escaped char
			continue;
		}
		// Bash single-quote escape pattern: '\'' produces a literal '
		// e.g., 'it'\''s' → the token content should be "it's"
		if (
			quote === "'" &&
			cmd[i] === "'" &&
			i + 3 < cmd.length &&
			cmd[i + 1] === "\\" &&
			cmd[i + 2] === "'" &&
			cmd[i + 3] === "'"
		) {
			i += 4; // skip: ' \ ' '
			continue;
		}
		if (cmd[i] === quote) {
			return i + 1; // past closing quote
		}
		i++;
	}
	return cmd.length; // unterminated
}

/**
 * Skip past a $(…) command substitution, returning the index AFTER the
 * closing `)`.  Handles nesting, quotes, and backslash escapes.
 * `start` must point to the `$` character.
 * Unterminated: returns cmd.length.
 */
function _skipSubstitution(cmd: string, start: number): number {
	let depth = 1;
	let i = start + 2; // skip $(
	while (i < cmd.length && depth > 0) {
		const ch = cmd[i]!;
		if (ch === "\\" && i + 1 < cmd.length) {
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			i = _skipQuoted(cmd, i);
			continue;
		}
		if (ch === "$" && i + 1 < cmd.length && cmd[i + 1] === "(") {
			depth++;
			i += 2;
			continue;
		}
		if (ch === ")") {
			depth--;
			i++;
			continue;
		}
		i++;
	}
	return i;
}

/**
 * Tokenize a SINGLE command segment (no pipe/semicolon/AND-OR separators)
 * into argv, respecting quotes, backslash escapes, and $(…) substitutions.
 *
 * This is the core tokenizer; `tokenizeCommand` handles separator splitting
 * and then delegates to this function for each segment.
 */
function _tokenizeOne(cmd: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < cmd.length) {
		// Skip whitespace between tokens
		while (i < cmd.length && /\s/.test(cmd[i]!)) i++;
		if (i >= cmd.length) break;

		if (cmd[i] === "'" || cmd[i] === '"') {
			const quote = cmd[i]!;
			const start = i;
			i = _skipQuoted(cmd, i);
			// Extract inner content (strip surrounding quotes)
			const inner = cmd.slice(start + 1, i - 1);
			// Handle bash '\'' escape for single quotes
			// The inner slice still contains the raw 4-char '\'' sequence;
			// each occurrence must collapse to a single literal '
			if (quote === "'") {
				tokens.push(inner.replace(/'\\''/g, "'"));
			} else {
				// Double-quote: remove backslash escapes
				tokens.push(inner.replace(/\\(.)/g, "$1"));
			}
		} else {
			let token = "";
			while (i < cmd.length && !/\s/.test(cmd[i]!)) {
				// $(…) — treat the whole substitution as one token
				if (cmd[i] === "$" && i + 1 < cmd.length && cmd[i + 1] === "(") {
					if (token.length > 0) {
						tokens.push(token);
						token = "";
					}
					const subStart = i;
					i = _skipSubstitution(cmd, i);
					tokens.push(cmd.slice(subStart, i));
					continue;
				}
				if (cmd[i] === "\\" && i + 1 < cmd.length) {
					i++; // skip backslash, take next char literally
				}
				token += cmd[i];
				i++;
			}
			if (token.length > 0) {
				tokens.push(token);
			}
		}
	}
	return tokens;
}

/* ─── public API ────────────────────────────────────────────────── */

/**
 * Tokenize a bash command string into argv, respecting quotes, escapes,
 * command substitution $(…), and pipe/separator boundaries.
 *
 * Splitting is performed on `|`, `;`, `&&`, `||` (outside quotes and $(…)),
 * then each segment is individually tokenized.  All tokens are returned as
 * one flat array.
 *
 * Handles:
 *   - Single quotes: literal content (bash '\'' escape produces literal ')
 *   - Double quotes: backslash escapes (\"  becomes ")
 *   - Unquoted backslash escapes: \X → X
 *   - $(…) command substitution: treated as a single token
 *   - Command separators: | ; && || split into segments before tokenizing
 */
export function tokenizeCommand(cmd: string): string[] {
	const raw = cmd;

	/* ---- split into segments at | ; && || (outside quotes / $()) ---- */
	const segments: string[] = [];
	let segStart = 0;
	let i = 0;

	while (i < raw.length) {
		const ch = raw[i]!;

		// Skip quoted regions
		if (ch === "'" || ch === '"') {
			i = _skipQuoted(raw, i);
			continue;
		}
		// Skip $(…) regions
		if (ch === "$" && i + 1 < raw.length && raw[i + 1] === "(") {
			i = _skipSubstitution(raw, i);
			continue;
		}

		// && separator
		if (ch === "&" && i + 1 < raw.length && raw[i + 1] === "&") {
			if (i > segStart) segments.push(raw.slice(segStart, i).trim());
			i += 2;
			segStart = i;
			continue;
		}
		// || separator (must check before standalone |)
		if (ch === "|" && i + 1 < raw.length && raw[i + 1] === "|") {
			if (i > segStart) segments.push(raw.slice(segStart, i).trim());
			i += 2;
			segStart = i;
			continue;
		}
		// | or ; separator
		if (ch === "|" || ch === ";") {
			if (i > segStart) segments.push(raw.slice(segStart, i).trim());
			i += 1;
			segStart = i;
			continue;
		}

		i++;
	}

	// Last segment
	if (segStart < raw.length) {
		const last = raw.slice(segStart).trim();
		if (last.length > 0) segments.push(last);
	}

	/* ---- tokenize each segment ---- */
	const tokens: string[] = [];
	for (const seg of segments) {
		for (const t of _tokenizeOne(seg)) {
			tokens.push(t);
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

/**
 * pi-shazam core/redact -- Shared secret redaction for audit logs.
 *
 * Single source of truth for SECRET_PATTERNS and redact().
 * Consumed by both mcp/tools.ts and hooks/tool-logger.ts.
 */

/** Patterns matching common secret formats for log redaction. */
export const SECRET_PATTERNS: RegExp[] = [
	// Multiline -- PEM private key blocks (also handled by accumulatePemBlocks for line-by-line safety)
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	// Connection strings with embedded credentials
	/(?:mongodb|postgres(?:ql)?|mysql|redis):\/\/[^:]*:[^@]*@/gi,
	// Bearer tokens (opaque, non-JWT)
	/bearer\s+[A-Za-z0-9_\-+=]{20,}/gi,
	/(?:token|secret|password|key|credential|auth)\s*[:=]\s*["'\w-]{8,}/gi,
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
	/(?:xox[abspr]-\d+-\d+-\d+-[a-f0-9]+)/gi,
	/AKIA[0-9A-Z]{16}/g,
	/(?:sk|rk)-[a-zA-Z0-9]{24,}/g,
	/(?:eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/g,
	/glpat-[\w-]{20,}/g,
	/AIza[\w-]{35}/g,
	/SG\.[\w-]{22,}/g,
	/SK[\w-]{32,}/g,
];

/** PEM header pattern for line-by-line detection. */
const PEM_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * Handle multiline PEM private key blocks in a line-by-line fashion.
 * Accumulates lines from BEGIN to END and replaces the whole block with [REDACTED].
 * Preserves original line endings (\n or \r\n).
 */
function accumulatePemBlocks(s: string): string {
	const lines = s.split("\n");
	const result: string[] = [];
	let inPem = false;

	for (const line of lines) {
		if (PEM_BEGIN_RE.test(line)) {
			inPem = true;
			result.push("[REDACTED]");
		} else if (inPem && PEM_END_RE.test(line)) {
			inPem = false;
			// END line absorbed into [REDACTED], skip output
		} else if (!inPem) {
			result.push(line);
		}
		// Lines inside PEM block (between BEGIN and END) are silently dropped
	}

	return result.join("\n");
}

/**
 * Redact potential secrets from a string.
 * Pure function -- no I/O, no logging.
 */
export function redact(s: string): string {
	// Step 1: Handle multiline PEM private key blocks
	let out = accumulatePemBlocks(s);

	// Step 2: Apply single-line secret patterns
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

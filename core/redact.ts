/**
 * pi-shazam core/redact — Shared secret redaction for audit logs.
 *
 * Single source of truth for SECRET_PATTERNS and redact().
 * Consumed by both mcp/tools.ts and hooks/tool-logger.ts.
 */

/** Patterns matching common secret formats for log redaction. */
export const SECRET_PATTERNS: RegExp[] = [
	/(?:token|secret|password|key|credential|auth)\s*[:=]\s*["'\w-]{8,}/gi,
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
	/(?:xox[abspr]-\d+-\d+-\d+-[a-f0-9]+)/gi,
	/AKIA[0-9A-Z]{16}/g,
	/(?:sk|rk)-[a-zA-Z0-9]{24,}/g,
	/(?:eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/g,
];

/**
 * Redact potential secrets from a string.
 * Pure function — no I/O, no logging.
 */
export function redact(s: string): string {
	let out = s;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

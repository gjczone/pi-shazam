/**
 * Log shazam tool calls to ~/.pi/hooks/audit/shazam-calls.log (JSONL).
 *
 * Each log entry captures the full result text (truncated at 10KB) for debugging:
 * - call:   ts, project, tool, params
 * - result: ts, project, tool, durationMs, success, error, result (truncated output)
 *
 * With 72h auto-cleanup via radar.ts, log size stays bounded.
 *
 * Uses shared JSONL write helpers from core/audit-log.ts.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { join } from "node:path";
import { redact } from "../core/redact.js";
import { AUDIT_LOG_DIR, ts, writeJsonl } from "../core/audit-log.js";
import { consumeLastToolTiming } from "../tools/_context.js";

const LOG_FILE = join(AUDIT_LOG_DIR, "shazam-calls.log");
const MAX_RESULT_CHARS = 10_000;

const _starts = new Map<string, number>();

function write(entry: Record<string, unknown>): void {
	writeJsonl(LOG_FILE, entry);
}

function isShazam(name: string): boolean {
	return name.startsWith("shazam_");
}

function summarize(v: unknown): unknown {
	if (v === null || v === undefined) return v;
	if (typeof v === "string") return v.length > 200 ? `[${v.length} chars]` : redact(v);
	if (Array.isArray(v)) return `[${(v as unknown[]).length} items]`;
	if (typeof v === "object") {
		const s: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			s[k] = summarize(val);
		}
		return s;
	}
	return v;
}

function cleanupState(): void {
	_starts.clear();
}

export function registerToolLogger(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (!isShazam(event.toolName)) return;
		const t0 = Date.now();
		_starts.set(event.toolCallId, t0);

		const input = event.input;

		write({
			ts: ts(),
			project: ctx.cwd,
			event: "call",
			tool: event.toolName,
			params: summarize(input),
		});
	});

	pi.on("tool_result", (event, ctx) => {
		if (!isShazam(event.toolName)) return;
		const start = _starts.get(event.toolCallId);
		const durationMs = start != null ? Date.now() - start : -1;
		_starts.delete(event.toolCallId);

		// Extract full result text
		const texts: string[] = [];
		if (event.content) {
			for (const c of event.content) {
				if (typeof c === "object" && "text" in c) texts.push(c.text);
			}
		}
		const combined = texts.join("\n");
		const redacted = redact(combined);
		const truncated =
			redacted.length > MAX_RESULT_CHARS
				? redacted.slice(0, MAX_RESULT_CHARS) +
					`\n... [truncated at ${MAX_RESULT_CHARS} chars, total was ${redacted.length}]`
				: redacted;

		const errorText = event.isError && texts[0] ? redact(texts[0].slice(0, 300)) : null;

		const entry: Record<string, unknown> = {
			ts: ts(),
			project: ctx.cwd,
			event: "result",
			tool: event.toolName,
			durationMs,
			success: !event.isError,
			error: errorText,
			result: truncated,
		};

		// Include nestedTiming if available (stored via _context.ts by instrumented tools)
		const timing = consumeLastToolTiming();
		if (timing) {
			entry.nestedTiming = timing;
		}

		write(entry);
	});

	// Clean up orphaned entries on session boundaries
	pi.on("session_start", () => {
		cleanupState();
	});

	pi.on("session_shutdown", () => {
		cleanupState();
	});
}

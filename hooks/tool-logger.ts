/**
 * Log shazam tool calls to ~/.pi/hooks/audit/shazam-calls.log (JSONL).
 *
 * Each log entry captures the full result text (truncated at 10KB) for debugging:
 * - call:   ts, project, tool, params
 * - result: ts, project, tool, durationMs, success, error, result (truncated output)
 *
 * With 72h auto-cleanup via radar.ts, log size stays bounded.
 */

import type { ExtensionAPI } from "../types/pi-extension.js";
import { appendFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../core/redact.js";
import { AUDIT_LOG_DIR, rotateAuditLog } from "../core/audit-log.js";

const AUDIT_DIR = AUDIT_LOG_DIR;
const LOG_FILE = join(AUDIT_DIR, "shazam-calls.log");
const MAX_RESULT_CHARS = 10_000;

const _starts = new Map<string, number>();
let _writeFailed = false;

async function ensureDir(): Promise<void> {
	await mkdir(AUDIT_DIR, { recursive: true });
	// Restrict access to audit directory and file
	try {
		await chmod(AUDIT_DIR, 0o700);
	} catch (err) {
		/* best-effort */
		console.warn("[pi-shazam] ensureDir: chmod failed for audit dir", err);
	}
}

async function rotateIfNeeded(): Promise<void> {
	await rotateAuditLog(LOG_FILE);
}

function ts(): string {
	const d = new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
}

// Async mutex for serializing log writes
let _writePromise: Promise<void> = Promise.resolve();

function write(entry: Record<string, unknown>): void {
	_writePromise = _writePromise.then(async () => {
		try {
			await ensureDir();
			await rotateIfNeeded();
			const json = redact(JSON.stringify(entry));
			await appendFile(LOG_FILE, json + "\n", "utf-8");
			try {
				await chmod(LOG_FILE, 0o600);
			} catch (err) {
				/* best-effort */
				console.warn("[pi-shazam] write: chmod failed for audit log file", err);
			}
			_writeFailed = false;
		} catch (err) {
			if (!_writeFailed) {
				_writeFailed = true;
				console.warn(`[pi-shazam] Audit log write failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	});
	// Prevent unhandled rejections from fire-and-forget writes
	_writePromise.catch((err) => console.error("[pi-shazam] Unexpected audit log error:", err));
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
	_writeFailed = false;
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

		write({
			ts: ts(),
			project: ctx.cwd,
			event: "result",
			tool: event.toolName,
			durationMs,
			success: !event.isError,
			error: event.isError ? (texts[0]?.slice(0, 300) ?? null) : null,
			result: truncated,
		});
	});

	// Clean up orphaned entries on session boundaries
	pi.on("session_start", () => {
		cleanupState();
	});

	pi.on("session_shutdown", () => {
		cleanupState();
	});
}

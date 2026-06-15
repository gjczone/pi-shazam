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
import { appendFile, mkdir, chmod, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUDIT_DIR = join(homedir(), ".pi", "hooks", "audit");
const LOG_FILE = join(AUDIT_DIR, "shazam-calls.log");
const MAX_RESULT_CHARS = 10_000;
const MAX_LOG_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Secret patterns for redaction ──────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
	/(?:token|secret|password|key|credential|auth)\s*[:=]\s*["'\w-]{8,}/gi,
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
	/(?:xox[abspr]-\d+-\d+-\d+-[a-f0-9]+)/gi,
	/AKIA[0-9A-Z]{16}/g,
	/(?:sk|rk)-[a-zA-Z0-9]{24,}/g,
	/(?:eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/g,
];

/**
 * Redact potential secrets from a string.
 */
function redact(s: string): string {
	let out = s;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

const _starts = new Map<string, number>();
let _writeFailed = false;

async function ensureDir(): Promise<void> {
	await mkdir(AUDIT_DIR, { recursive: true });
	// Restrict access to audit directory and file
	try {
		await chmod(AUDIT_DIR, 0o700);
	} catch {
		/* best-effort */
	}
}

async function rotateIfNeeded(): Promise<void> {
	try {
		if (!existsSync(LOG_FILE)) return;
		const st = await stat(LOG_FILE);
		const tooBig = st.size > MAX_LOG_SIZE_BYTES;
		const tooOld = Date.now() - st.mtimeMs > MAX_LOG_AGE_MS;
		if (tooBig || tooOld) {
			await unlink(LOG_FILE);
		}
	} catch {
		/* best-effort */
	}
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
			} catch {
				/* best-effort */
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
	_writePromise.catch(() => {});
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

		const input = "input" in event ? (event as unknown as Record<string, unknown>).input : {};

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

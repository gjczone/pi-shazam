/**
 * Log shazam tool calls to ~/.pi/hooks/audit/shazam-calls.log (JSONL)
 * for usage analytics and optimization.
 *
 * Log format (one JSON object per line):
 * {
 *   "ts": "2026-06-06T19:30:00+0800",
 *   "project": "/home/user/project",
 *   "tool": "shazam_overview",
 *   "params": { "filter": "index" },
 *   "durationMs": 342,
 *   "success": true,
 *   "error": null,
 *   "resultSize": 1234
 * }
 *
 * Follows the same pattern as audit-guard.ts (writes to ~/.pi/hooks/audit/).
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUDIT_DIR = join(homedir(), ".pi", "hooks", "audit");
const LOG_FILE = join(AUDIT_DIR, "shazam-calls.log");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const _starts = new Map<string, number>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(): void {
	mkdirSync(AUDIT_DIR, { recursive: true });
}

function ts(): string {
	const d = new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
}

function write(line: string): void {
	try {
		ensureDir();
		appendFileSync(LOG_FILE, line + "\n", "utf-8");
	} catch {
		/* silent */
	}
}

function isShazamTool(name: string): boolean {
	return name.startsWith("shazam_");
}

function summarize(v: unknown): unknown {
	if (v === null || v === undefined) return v;
	if (typeof v === "string") {
		return v.length > 200 ? `[${v.length} chars]` : v;
	}
	if (Array.isArray(v)) {
		return `[${(v as unknown[]).length} items]`;
	}
	if (typeof v === "object") {
		const o = v as Record<string, unknown>;
		const s: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(o)) {
			s[k] = summarize(val);
		}
		return s;
	}
	return v;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerToolLogger(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (!isShazamTool(event.toolName)) return;
		_starts.set(event.toolCallId, Date.now());

		const input = "input" in event ? (event as unknown as Record<string, unknown>).input : {};

		write(JSON.stringify({
			ts: ts(),
			project: ctx.cwd,
			event: "call",
			tool: event.toolName,
			params: summarize(input),
		}));
	});

	pi.on("tool_result", (event, ctx) => {
		if (!isShazamTool(event.toolName)) return;
		const start = _starts.get(event.toolCallId);
		const durationMs = start != null ? Date.now() - start : -1;
		_starts.delete(event.toolCallId);

		const content = event.content;
		const resultSize = content
			? content.reduce((sum: number, c) => sum + ((c as { text?: string }).text?.length ?? 0), 0)
			: 0;

		write(JSON.stringify({
			ts: ts(),
			project: ctx.cwd,
			event: "result",
			tool: event.toolName,
			durationMs,
			success: !event.isError,
			resultSize,
			error: event.isError
				? content?.map((c) => (c as { text?: string }).text?.slice(0, 200)).filter(Boolean)[0]
				: null,
		}));
	});
}

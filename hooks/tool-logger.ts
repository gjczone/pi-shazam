/**
 * Log shazam tool calls to ~/.pi/hooks/audit/shazam-calls.log (JSONL).
 *
 * Each log entry captures enough detail for debugging and optimization:
 * - Basic: ts, project, tool, event, durationMs, success
 * - Tool-specific: verdict (verify), hitCount (codesearch), symbolCount (overview), etc.
 * - Error: error message (truncated)
 * - Context: result size, params summary
 *
 * Follows audit-guard.ts pattern: writes to ~/.pi/hooks/audit/.
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUDIT_DIR = join(homedir(), ".pi", "hooks", "audit");
const LOG_FILE = join(AUDIT_DIR, "shazam-calls.log");

const _starts = new Map<string, number>();

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

function write(entry: Record<string, unknown>): void {
	try {
		ensureDir();
		appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
	} catch {
		/* silent */
	}
}

function isShazam(name: string): boolean {
	return name.startsWith("shazam_");
}

/** Extract tool-specific metadata from result text */
function extractMeta(tool: string, text: string): Record<string, unknown> {
	const meta: Record<string, unknown> = {};
	const t = text.slice(0, 500);

	// verify: check for PASS / WARN / FAIL verdict
	if (tool === "shazam_verify") {
		if (t.includes("PASS")) meta.verdict = "PASS";
		else if (t.includes("FAIL")) meta.verdict = "FAIL";
		else if (t.includes("WARN")) meta.verdict = "WARN";
	}

	// codesearch / overview: count results
	const symbolMatches = t.match(/(\d+) symbols?/i);
	if (symbolMatches) meta.symbolCount = parseInt(symbolMatches[1], 10);

	const fileMatches = t.match(/(\d+) files?/i);
	if (fileMatches) meta.fileCount = parseInt(fileMatches[1], 10);

	// call_chain: reference count
	const refMatches = t.match(/(\d+) references?/i);
	if (refMatches) meta.refCount = parseInt(refMatches[1], 10);

	return meta;
}

function summarize(v: unknown): unknown {
	if (v === null || v === undefined) return v;
	if (typeof v === "string") return v.length > 200 ? `[${v.length} chars]` : v;
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

		// Extract result text for metadata parsing
		const texts: string[] = [];
		if (event.content) {
			for (const c of event.content) {
				if (typeof c === "object" && "text" in c) texts.push(c.text);
			}
		}
		const combined = texts.join("\n");
		const meta = extractMeta(event.toolName, combined);

		write({
			ts: ts(),
			project: ctx.cwd,
			event: "result",
			tool: event.toolName,
			durationMs,
			success: !event.isError,
			resultSize: combined.length,
			error: event.isError ? texts[0]?.slice(0, 300) : null,
			...meta,
		});
	});
}

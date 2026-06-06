/**
 * Log shazam tool calls to ~/.pi/shazam-calls.log (JSONL) for analytics.
 *
 * Each log line is one JSON object:
 * { "ts": "ISO-8601", "tool": "shazam_overview", "args": {...}, "durationMs": 342, "success": true }
 */
import type { ExtensionAPI } from "../types/pi-extension.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const _starts = new Map<string, number>();

function logPath(): string {
	const dir = join(homedir(), ".pi");
	mkdirSync(dir, { recursive: true });
	return join(dir, "shazam-calls.log");
}

function writeLog(entry: Record<string, unknown>): void {
	try {
		appendFileSync(logPath(), JSON.stringify(entry) + "\n", "utf-8");
	} catch {
		/* silent */
	}
}

function isShazamTool(name: string): boolean {
	return name.startsWith("shazam_");
}

function summarizeArgs(args: unknown): Record<string, unknown> {
	if (typeof args !== "object" || args === null) return { raw: String(args) };
	const a = args as Record<string, unknown>;
	const s: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(a)) {
		if (typeof v === "string" && v.length > 200) s[k] = `[${v.length} chars]`;
		else if (Array.isArray(v)) s[k] = `${(v as unknown[]).length} items`;
		else s[k] = v;
	}
	return s;
}

export function registerToolLogger(pi: ExtensionAPI): void {
	pi.on("tool_execution_start", (event) => {
		if (!isShazamTool(event.toolName)) return;
		_starts.set(event.toolCallId, Date.now());
	});

	pi.on("tool_execution_end", (event) => {
		if (!isShazamTool(event.toolName)) return;
		const start = _starts.get(event.toolCallId);
		const durationMs = start != null ? Date.now() - start : -1;
		_starts.delete(event.toolCallId);

		writeLog({
			ts: new Date().toISOString(),
			tool: event.toolName,
			result: summarizeArgs(event.result),
			durationMs,
			success: !event.isError,
		});
	});
}

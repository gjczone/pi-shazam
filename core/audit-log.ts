/**
 * pi-shazam core/audit-log -- Unified audit log rotation.
 *
 * Single source of truth for audit log retention policy.
 * Both mcp/tools.ts and hooks/tool-logger.ts delegate to rotateAuditLog().
 *
 * Policy:
 *   - Max 10 MB per log file before rotation
 *   - Keep up to 5 archived copies (shazam-calls.log.1 through .5)
 *   - Max 30 days age for any single log file
 *   - On rotation: cascade-rename .4->.5, .3->.4, …, .log->.log.1
 *   - On age: delete the entire log file (content older than 30 days is stale)
 */

import { stat, rename, unlink, appendFile, mkdir, chmod } from "node:fs/promises";
import { _logWarn } from "./output.js";
import { join } from "node:path";
import { homedir } from "node:os";

/** Default directory for shazam audit logs. */
export const AUDIT_LOG_DIR = join(homedir(), ".pi", "hooks", "audit");

/** Max log file size before rotation (10 MB). */
export const MAX_AUDIT_LOG_SIZE = 10 * 1024 * 1024;

/** Max number of archived log copies to retain. */
export const MAX_AUDIT_LOG_FILES = 5;

/** Max age of a log file before it is rotated out (30 days in ms). */
export const MAX_AUDIT_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Path to the internal event log. */
export const INTERNAL_LOG_PATH = join(AUDIT_LOG_DIR, "internal.log");

/**
 * Rotate the audit log at `logPath`.
 *
 * - If file size exceeds MAX_AUDIT_LOG_SIZE -> cascade-rename archived copies
 *   (log.4->log.5, …, log->log.1) and let a new log file be created on next write.
 * - If file age exceeds MAX_AUDIT_LOG_AGE_MS -> delete the file (it will be
 *   recreated on next write with fresh content).
 */
export async function rotateAuditLog(logPath: string): Promise<void> {
	try {
		const st = await stat(logPath);
		const tooBig = st.size > MAX_AUDIT_LOG_SIZE;
		const tooOld = Date.now() - st.mtimeMs > MAX_AUDIT_LOG_AGE_MS;

		if (tooBig) {
			// Cascade-rename: shift archives up by one
			for (let i = MAX_AUDIT_LOG_FILES - 1; i >= 1; i--) {
				const src = `${logPath}.${i}`;
				const dst = `${logPath}.${i + 1}`;
				try {
					await rename(src, dst);
				} catch (err) {
					// file may not exist yet
					_logWarn("rotateAuditLog", `rename ${src} -> ${dst} failed`, err);
				}
			}
			// Move current log to .1
			await rename(logPath, `${logPath}.1`);
		} else if (tooOld) {
			// Delete the entire log -- it will be recreated on next write
			await unlink(logPath);
		}
	} catch (err) {
		// File may not exist yet -- first write creates it
		_logWarn("rotateAuditLog", `stat/unlink failed for ${logPath}`, err);
	}
}

// -- Shared JSONL write helpers --------------------------------------------

/** ISO-8601 timestamp with timezone offset. */
export function ts(): string {
	const d = new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
}

export let _logDirEnsured = false;

/** Ensure the audit log directory exists with restricted permissions. */
export async function ensureLogDir(): Promise<void> {
	if (_logDirEnsured) return;
	await mkdir(AUDIT_LOG_DIR, { recursive: true });
	try {
		await chmod(AUDIT_LOG_DIR, 0o700);
	} catch {
		// best-effort
	}
	_logDirEnsured = true;
}

// Async mutex for serializing log writes
let _writeMutex: Promise<void> = Promise.resolve();

/**
 * Serialized JSONL write to a log path.
 * Ensures the directory exists, rotates if needed, then appends.
 */
export async function writeJsonlEntry(logPath: string, data: Record<string, unknown>): Promise<void> {
	await ensureLogDir();
	await rotateAuditLog(logPath);
	const json = JSON.stringify(data);
	await appendFile(logPath, json + "\n", "utf-8");
	try {
		await chmod(logPath, 0o600);
	} catch {
		// best-effort
	}
}

/**
 * Queue a JSONL write via async mutex.
 * Fire-and-forget: swallows write errors to avoid unhandled rejections.
 */
export function writeJsonl(logPath: string, data: Record<string, unknown>): void {
	_writeMutex = _writeMutex
		.then(() => writeJsonlEntry(logPath, data))
		.catch((err) => {
			_logWarn("audit-log", `writeJsonl failed for ${logPath}`, err);
		});
}

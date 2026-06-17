/**
 * pi-shazam core/audit-log — Unified audit log rotation.
 *
 * Single source of truth for audit log retention policy.
 * Both mcp/tools.ts and hooks/tool-logger.ts delegate to rotateAuditLog().
 *
 * Policy:
 *   - Max 10 MB per log file before rotation
 *   - Keep up to 5 archived copies (shazam-calls.log.1 through .5)
 *   - Max 30 days age for any single log file
 *   - On rotation: cascade-rename .4→.5, .3→.4, …, .log→.log.1
 *   - On age: delete the entire log file (content older than 30 days is stale)
 */

import { stat, rename, unlink } from "node:fs/promises";
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

/**
 * Rotate the audit log at `logPath`.
 *
 * - If file size exceeds MAX_AUDIT_LOG_SIZE → cascade-rename archived copies
 *   (log.4→log.5, …, log→log.1) and let a new log file be created on next write.
 * - If file age exceeds MAX_AUDIT_LOG_AGE_MS → delete the file (it will be
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
				} catch {
					// file may not exist yet
				}
			}
			// Move current log to .1
			await rename(logPath, `${logPath}.1`);
		} else if (tooOld) {
			// Delete the entire log — it will be recreated on next write
			await unlink(logPath);
		}
	} catch {
		// File may not exist yet — first write creates it
	}
}

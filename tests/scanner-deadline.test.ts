/**
 * Tests for issue #720: scanProject deadline enforcement.
 *
 * Background: `_walkDirectory` previously had no wall-clock budget. A
 * pathological directory tree (deeply nested, large entry counts) could
 * keep the synchronous scanner busy for 30+ seconds, blocking MCP startup
 * or native agent startup.
 *
 * The deadline is opt-in via the env var `PI_SHAZAM_SCAN_DEADLINE_MS`
 * (default 10000 ms). When exceeded, `_walkDirectory` aborts further
 * descent, marks the result as `truncated`, and emits a warning.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanProject, resetCache } from "../core/scanner.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIGINAL_DEADLINE = process.env.PI_SHAZAM_SCAN_DEADLINE_MS;

/**
 * Build a fixture with many sibling directories under a single root.
 * Each directory contains a single .ts file so the scanner descends
 * into every one. This makes the first pass measurable on slow runners.
 */
function createWideFixture(width: number, depth = 1): string {
	const root = mkdtempSync(join(tmpdir(), "pi-shazam-deadline-"));
	for (let i = 0; i < width; i++) {
		const dir = join(root, `pkg_${i.toString().padStart(4, "0")}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.ts"), `export const v${i} = ${i};\n`);
		if (depth > 1) {
			for (let d = 0; d < depth - 1; d++) {
				const sub = join(dir, `sub_${d}`);
				mkdirSync(sub);
				writeFileSync(join(sub, "x.ts"), `export const x${i}_${d} = 0;\n`);
			}
		}
	}
	return root;
}

describe("scanProject scan deadline (issue #720)", () => {
	beforeEach(() => {
		resetCache();
	});

	afterEach(() => {
		if (ORIGINAL_DEADLINE === undefined) {
			delete process.env.PI_SHAZAM_SCAN_DEADLINE_MS;
		} else {
			process.env.PI_SHAZAM_SCAN_DEADLINE_MS = ORIGINAL_DEADLINE;
		}
		resetCache();
	});

	it("does not set truncated=true on a small fixture under the default deadline", () => {
		delete process.env.PI_SHAZAM_SCAN_DEADLINE_MS;
		const root = createWideFixture(20, 2);
		try {
			const graph = scanProject(root);
			expect(graph.truncated).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	it("aborts and sets truncated=true when PI_SHAZAM_SCAN_DEADLINE_MS forces an early stop", () => {
		// Force the deadline to 1 ms so the scanner aborts during the
		// first readdirSync of a wide fixture. The deadline fires after
		// at least one entry is processed, so the result has some files
		// but is flagged truncated.
		process.env.PI_SHAZAM_SCAN_DEADLINE_MS = "1";
		const root = createWideFixture(200, 3);
		try {
			const graph = scanProject(root);
			// With a 1 ms budget the walk cannot cover 200 * 3 dirs.
			expect(graph.truncated).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 3 });
		}
	});
});

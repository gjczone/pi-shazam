/**
 * Tests for the autoFormatFile path guard hardening (issues #688 / #697).
 *
 * Background: autoFormatFile previously guarded formatting with `isPathInRoot`,
 * a string-only `relative()` check. That passes a symlink whose *string* path
 * sits inside the project root even when the symlink target escapes to a file
 * OUTSIDE the root -- letting the formatter overwrite an external file.
 *
 * The fix routes the guard through `validatePathInProject`, which additionally
 * runs a `realpathSync` symlink-resolution check. This test proves the gap:
 * `isPathInRoot` accepts the symlink string while `validatePathInProject`
 * rejects the escape. The hook must use the latter.
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isPathInRoot, validatePathInProject } from "../tools/_factory.js";

describe("autoFormatFile symlink-escape guard (#688)", () => {
	it("rejects a symlink inside the project root pointing outside it", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-shazam-688-root-"));
		const outside = mkdtempSync(join(tmpdir(), "pi-shazam-688-outside-"));
		try {
			// A sensitive file sitting OUTSIDE the project root.
			const externalTarget = join(outside, "secret.txt");
			writeFileSync(externalTarget, "do-not-touch\n");

			// A symlink inside the project root whose string path is in-root,
			// but whose real target escapes the root.
			const linkInRoot = join(root, "escape-link.txt");
			symlinkSync(externalTarget, linkInRoot);

			// The weak string-only check still accepts the symlink string.
			expect(isPathInRoot(linkInRoot, root)).toBe(true);

			// The hardened check must reject the symlink-escape (this is what
			// autoFormatFile must now use to block formatting the external file).
			expect(validatePathInProject(linkInRoot, root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("still accepts a genuine in-root file (no symlink escape)", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-shazam-688-root2-"));
		try {
			const inRoot = join(root, "real.ts");
			writeFileSync(inRoot, "export const x = 1;\n");
			expect(validatePathInProject(inRoot, root)).toBe(true);
			expect(isPathInRoot(inRoot, root)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

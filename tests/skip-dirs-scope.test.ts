/**
 * Tests for issue #724: scope the home-directory SKIP_DIRS additions
 * so they do not silently skip real source directories when the project
 * root lives outside $HOME.
 *
 * Background (#720): SKIP_DIRS was extended with cross-platform
 * non-source trees commonly found under $HOME (snap, Library,
 * Documents, ...). Without scoping, a project literally named
 * `library` or `documents` at the top level would be skipped even when
 * the user runs pi-shazam from a workspace path that is not under home.
 *
 * The split:
 *  - SKIP_DIRS (always active): directories that never conflict with
 *    real source directory names (node_modules, dist, build, ...).
 *  - HOME_SKIP_DIRS (active only when the project root is under $HOME):
 *    cross-platform non-source trees that may legitimately collide
 *    with real project names (Library, Documents, ...).
 *
 * Both sets are exposed via `getEffectiveSkipDirs(root)` so the scanner
 * does not need to know about the split.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { collectSourceFiles, resetCache } from "../core/scanner.js";
import { SKIP_DIRS, HOME_SKIP_DIRS, getEffectiveSkipDirs } from "../core/filter.js";
import { setProjectRoot, resetProjectRoot } from "../core/scanner.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_ALLOW = process.env.PI_SHAZAM_ALLOW_HOME;

beforeEach(() => {
	resetCache();
});

afterEach(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
	if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
	if (ORIGINAL_ALLOW === undefined) delete process.env.PI_SHAZAM_ALLOW_HOME;
	else process.env.PI_SHAZAM_ALLOW_HOME = ORIGINAL_ALLOW;
	resetProjectRoot();
	resetCache();
});

function makeProjectWithTopLevelDir(dirName: string, fixtureSuffix = "scope"): string {
	const root = mkdtempSync(join(tmpdir(), `pi-shazam-${fixtureSuffix}-`));
	mkdirSync(join(root, dirName));
	writeFileSync(join(root, dirName, "index.ts"), `export const tag_${dirName} = "${dirName}";\n`);
	writeFileSync(join(root, "main.ts"), `export const ok = 1;\n`);
	return root;
}

describe("SKIP_DIRS / HOME_SKIP_DIRS split (issue #724)", () => {
	it("SKIP_DIRS keeps the always-active set", () => {
		expect(SKIP_DIRS.has("node_modules")).toBe(true);
		expect(SKIP_DIRS.has("dist")).toBe(true);
		expect(SKIP_DIRS.has("build")).toBe(true);
		expect(SKIP_DIRS.has(".git")).toBe(true);
	});

	it("HOME_SKIP_DIRS contains cross-platform home-only non-source trees", () => {
		// Linux
		expect(HOME_SKIP_DIRS.has("snap")).toBe(true);
		// macOS
		expect(HOME_SKIP_DIRS.has("Library")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Applications")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Movies")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Music")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Pictures")).toBe(true);
		// Windows
		expect(HOME_SKIP_DIRS.has("Application Data")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Desktop")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Downloads")).toBe(true);
		expect(HOME_SKIP_DIRS.has("Documents")).toBe(true);
		// Linux additional home-only
		expect(HOME_SKIP_DIRS.has(".Trash")).toBe(true);
	});

	it("HOME_SKIP_DIRS does NOT overlap SKIP_DIRS (single source of truth)", () => {
		for (const entry of HOME_SKIP_DIRS) {
			expect(SKIP_DIRS.has(entry)).toBe(false);
		}
	});

	it("does not include entries that may collide with real source dirs", () => {
		// spot-check: 'src' or 'lib' or 'test' must never be in either set.
		expect(SKIP_DIRS.has("src")).toBe(false);
		expect(SKIP_DIRS.has("lib")).toBe(false);
		expect(SKIP_DIRS.has("test")).toBe(false);
	});

	it("getEffectiveSkipDirs returns SKIP_DIRS for a non-home root", () => {
		const root = makeProjectWithTopLevelDir("Library");
		const effective = getEffectiveSkipDirs(root);
		expect(effective.has("node_modules")).toBe(true);
		// HOME_SKIP_DIRS entries must NOT be active for a non-home root.
		expect(effective.has("Library")).toBe(false);
		expect(effective.has("Documents")).toBe(false);
	});

	it("getEffectiveSkipDirs returns SKIP_DIRS + HOME_SKIP_DIRS for a root under $HOME", () => {
		// Forge a fake home by setting HOME to a real temp dir we own,
		// then nest the project under it.
		const fakeHome = mkdtempSync(join(tmpdir(), "pi-shazam-fakehome-"));
		process.env.HOME = fakeHome;
		process.env.PI_SHAZAM_ALLOW_HOME = "1";
		const projectDir = join(fakeHome, "projects", "Library");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "index.ts"), "export const ok = 1;\n");

		const effective = getEffectiveSkipDirs(projectDir);
		expect(effective.has("node_modules")).toBe(true);
		expect(effective.has("Library")).toBe(true);
		expect(effective.has("Documents")).toBe(true);

		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("getEffectiveSkipDirs falls back to USERPROFILE on Windows-style runners", () => {
		const fakeProfile = mkdtempSync(join(tmpdir(), "pi-shazam-fakeprofile-"));
		delete process.env.HOME;
		process.env.USERPROFILE = fakeProfile;
		process.env.PI_SHAZAM_ALLOW_HOME = "1";
		const projectDir = join(fakeProfile, "Documents");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "index.ts"), "export const ok = 1;\n");

		const effective = getEffectiveSkipDirs(projectDir);
		expect(effective.has("Documents")).toBe(true);

		rmSync(fakeProfile, { recursive: true, force: true });
	});
});

describe("scanProject respects getEffectiveSkipDirs (issue #724)", () => {
	it("does NOT skip a top-level 'Library' directory when project root is outside $HOME", () => {
		const root = makeProjectWithTopLevelDir("Library");
		const graph = collectSourceFiles(root, 20_000, false);
		const entries = [...graph.files].map((f) => f.split(sep).join("/"));
		expect(entries).toContain("Library/index.ts");
		expect(entries).toContain("main.ts");
		expect(graph.truncated).toBe(false);
	});

	it("does NOT skip a top-level 'Documents' directory when project root is outside $HOME", () => {
		const root = makeProjectWithTopLevelDir("Documents");
		const graph = collectSourceFiles(root, 20_000, false);
		const entries = [...graph.files].map((f) => f.split(sep).join("/"));
		expect(entries).toContain("Documents/index.ts");
	});

	it("does NOT skip a top-level 'snap' directory when project root is outside $HOME", () => {
		const root = makeProjectWithTopLevelDir("snap");
		const graph = collectSourceFiles(root, 20_000, false);
		const entries = [...graph.files].map((f) => f.split(sep).join("/"));
		expect(entries).toContain("snap/index.ts");
	});

	it("DOES skip 'Library' when project root is under $HOME", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "pi-shazam-fakehome-skip-"));
		process.env.HOME = fakeHome;
		process.env.PI_SHAZAM_ALLOW_HOME = "1";
		const projectDir = join(fakeHome, "code", "myproj");
		mkdirSync(join(projectDir, "Library"), { recursive: true });
		writeFileSync(join(projectDir, "Library", "noise.ts"), "export const noise = 1;\n");
		writeFileSync(join(projectDir, "main.ts"), "export const ok = 1;\n");

		const graph = collectSourceFiles(projectDir, 20_000, false);
		const entries = [...graph.files].map((f) => f.split(sep).join("/"));
		// Library is skipped, main.ts is kept.
		expect(entries.some((e) => e.includes("Library/"))).toBe(false);
		expect(entries).toContain("main.ts");

		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("still skips 'node_modules' regardless of $HOME scope", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-shazam-nm-"));
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "node_modules", "noise.ts"), "export const noise = 1;\n");
		writeFileSync(join(root, "main.ts"), "export const ok = 1;\n");

		const graph = collectSourceFiles(root, 20_000, false);
		const entries = [...graph.files].map((f) => f.split(sep).join("/"));
		expect(entries.some((e) => e.includes("node_modules/"))).toBe(false);
		expect(entries).toContain("main.ts");
	});
});

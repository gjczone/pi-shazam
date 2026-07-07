/**
 * Tests for issue #668: PI_SHAZAM_HOME_ONLY must accept Windows projects
 * under USERPROFILE. The containment check normalizes both sides with
 * resolve()/sep so backslash realRoots match a forward-slash homeDir.
 *
 * The fix computes `realRoot.startsWith(resolve(homeDir) + sep)`. On real
 * Windows, path.resolve normalizes to backslashes and sep is "\\"; the same
 * code path is exercised here with forward-slash "Windows-style" paths
 * (C:/Users/me) which resolve() preserves, validating the containment logic
 * without depending on the host platform's separator.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../core/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/output.js")>();
	return { ...actual, _logWarn: logWarn };
});

// Controllable node:path so the win32 branch can be exercised on a Linux runner.
const pathState = vi.hoisted(() => ({ sep: "/", resolve: (p: string) => p }));
vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>();
	return {
		...actual,
		get sep() {
			return pathState.sep;
		},
		resolve: (...args: string[]) => pathState.resolve(args[args.length - 1] ?? "."),
		dirname: (p: string) => p,
	};
});

const realpathOrig = vi.hoisted(() => require("node:fs").realpathSync);
const statSyncOrig = vi.hoisted(() => require("node:fs").statSync);
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		realpathSync: vi.fn(actual.realpathSync),
		statSync: vi.fn(actual.statSync),
	};
});

vi.mock("node:process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:process")>();
	return { ...actual, exit: vi.fn() };
});

import { realpathSync as realpathMock, statSync as statSyncMock } from "node:fs";
import { validateProjectRoot } from "../mcp/entry.js";

const savedEnv = { ...process.env };

beforeEach(() => {
	logWarn.mockClear();
	pathState.sep = "/";
	pathState.resolve = (p: string) => p;
	vi.mocked(realpathMock).mockImplementation(realpathOrig);
	vi.mocked(statSyncMock).mockReturnValue({ isDirectory: () => true } as never);
});

afterEach(() => {
	process.env = { ...savedEnv };
	vi.mocked(realpathMock).mockRestore();
	vi.mocked(statSyncMock).mockRestore();
});

describe("issue #668: PI_SHAZAM_HOME_ONLY accepts Windows home projects", () => {
	it("accepts a Windows nested project under USERPROFILE", () => {
		pathState.sep = "\\";
		pathState.resolve = (p: string) => p.replace(/\//g, "\\");
		delete process.env.HOME; // ensure USERPROFILE is the resolved home dir
		process.env.PI_SHAZAM_HOME_ONLY = "1";
		process.env.USERPROFILE = "C:\\Users\\me";
		vi.mocked(realpathMock).mockReturnValue("C:\\Users\\me\\project" as never);

		const res = validateProjectRoot("C:\\Users\\me\\project");
		expect(res.ok).toBe(true);
	});

	it("rejects a Windows project outside USERPROFILE", () => {
		pathState.sep = "\\";
		pathState.resolve = (p: string) => p.replace(/\//g, "\\");
		delete process.env.HOME;
		process.env.PI_SHAZAM_HOME_ONLY = "1";
		process.env.USERPROFILE = "C:\\Users\\me";
		vi.mocked(realpathMock).mockReturnValue("D:\\other\\project" as never);

		const res = validateProjectRoot("D:\\other\\project");
		expect(res.ok).toBe(false);
	});

	it("still accepts a POSIX nested project under HOME", () => {
		process.env.PI_SHAZAM_HOME_ONLY = "1";
		process.env.HOME = "/home/me";
		vi.mocked(realpathMock).mockReturnValue("/home/me/project" as never);

		const res = validateProjectRoot("/home/me/project");
		expect(res.ok).toBe(true);
	});
});

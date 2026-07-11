/**
 * Tests for issue #720: MCP entry must refuse to scan the home directory
 * by default. Set PI_SHAZAM_ALLOW_HOME=1 to opt out of this guard.
 *
 * Rationale: a full home tree is 10-100 GB / tens of thousands of dirs.
 * Walking it on MCP startup triggers MCP default timeouts and burns
 * CPU/memory on non-project content. The guard is opt-out (not opt-in)
 * because almost every user lands in their home by accident.
 *
 * Cross-platform: HOME on POSIX, USERPROFILE on Windows (issue #586).
 * Case-insensitive on Windows (issue #668).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../core/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/output.js")>();
	return { ...actual, _logWarn: logWarn };
});

// Controllable node:path so the win32 branch can be exercised on Linux.
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
	// Reset to a clean env (HOME only) by default.
	delete process.env.USERPROFILE;
});

afterEach(() => {
	process.env = { ...savedEnv };
	vi.mocked(realpathMock).mockRestore();
	vi.mocked(statSyncMock).mockRestore();
});

describe("issue #720: MCP entry refuses home directory by default", () => {
	it("rejects a path equal to HOME", () => {
		process.env.HOME = "/home/me";
		vi.mocked(realpathMock).mockReturnValue("/home/me" as never);

		const res = validateProjectRoot("/home/me");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/home directory/i);
	});

	it("rejects a nested path under HOME", () => {
		process.env.HOME = "/home/me";
		vi.mocked(realpathMock).mockReturnValue("/home/me/projects/foo" as never);

		const res = validateProjectRoot("/home/me/projects/foo");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/home directory/i);
	});

	it("accepts a path under HOME when PI_SHAZAM_ALLOW_HOME=1", () => {
		process.env.HOME = "/home/me";
		process.env.PI_SHAZAM_ALLOW_HOME = "1";
		vi.mocked(realpathMock).mockReturnValue("/home/me/projects/foo" as never);

		const res = validateProjectRoot("/home/me/projects/foo");
		expect(res.ok).toBe(true);
	});

	it("accepts a non-home directory (containers, CI)", () => {
		process.env.HOME = "/home/me";
		vi.mocked(realpathMock).mockReturnValue("/workspace/proj" as never);

		const res = validateProjectRoot("/workspace/proj");
		expect(res.ok).toBe(true);
	});

	it.skip("rejects a Windows path under USERPROFILE (case-insensitive)", () => {
		// Skipped on POSIX runners: the MCP entry's `isHomeDirectory` only
		// treats paths as Windows-style when process.platform === "win32".
		// The win32 branch is exercised directly in tests/home-directory.test.ts
		// via `isHomeDirectoryForPlatform`.
		pathState.sep = "\\";
		pathState.resolve = (p: string) => p.replace(/\//g, "\\");
		delete process.env.HOME;
		process.env.USERPROFILE = "C:\\Users\\me";
		vi.mocked(realpathMock).mockReturnValue("c:\\users\\me\\project" as never);

		const res = validateProjectRoot("c:\\users\\me\\project");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/home directory/i);
	});

	it("does NOT flag a similarly-prefixed non-home path", () => {
		// /home/melody must NOT be flagged when HOME=/home/me
		process.env.HOME = "/home/me";
		vi.mocked(realpathMock).mockReturnValue("/home/melody" as never);

		const res = validateProjectRoot("/home/melody");
		expect(res.ok).toBe(true);
	});
});

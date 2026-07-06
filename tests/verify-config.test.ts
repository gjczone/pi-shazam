/**
 * Tests for .pi-shazam/config.json loader (#630).
 *
 * Mocks the scanner's getEffectiveRoot to point at a real temp directory
 * so the loader reads from a real `.pi-shazam/config.json` on disk.
 * This mirrors the production contract: loadConfig() reads from the
 * project root, no matter which process is calling.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({
	projectRoot: "",
	logWarnCalls: [] as Array<{ tag: string; message: string }>,
}));

vi.mock("../core/scanner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/scanner.js")>();
	return {
		...actual,
		getEffectiveRoot: () => hoisted.projectRoot,
	};
});

vi.mock("../core/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/output.js")>();
	return {
		...actual,
		_logWarn: (tag: string, message: string, _err?: unknown) => {
			hoisted.logWarnCalls.push({ tag, message });
		},
	};
});

import { loadConfig, _resetConfigCache } from "../core/config.js";

let tmpRoot = "";

function makeProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "shazam-cfg-"));
	mkdirSync(join(dir, ".pi-shazam"), { recursive: true });
	return dir;
}

function writeConfig(content: string): void {
	writeFileSync(join(tmpRoot, ".pi-shazam", "config.json"), content, "utf-8");
}

describe("loadConfig (#630)", () => {
	beforeEach(() => {
		_resetConfigCache();
		hoisted.logWarnCalls = [];
		// Clean up the previous tmp dir
		if (tmpRoot) {
			try {
				rmSync(tmpRoot, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
		tmpRoot = makeProject();
		hoisted.projectRoot = tmpRoot;
	});

	it("returns empty object when no config file exists", () => {
		// .pi-shazam/ exists but no config.json inside
		const config = loadConfig();
		expect(config).toEqual({});
	});

	it("reads verify.maxFiles from the config file", () => {
		writeConfig(JSON.stringify({ verify: { maxFiles: 50 } }));
		const config = loadConfig();
		expect(config.verify?.maxFiles).toBe(50);
	});

	it("tolerates an empty config file", () => {
		writeConfig("{}");
		const config = loadConfig();
		expect(config).toEqual({});
	});

	it("tolerates unknown top-level keys (loose schema)", () => {
		writeConfig(JSON.stringify({ unknown: { x: 1 }, verify: { maxFiles: 25 } }));
		const config = loadConfig();
		expect(config.verify?.maxFiles).toBe(25);
		expect((config as Record<string, unknown>).unknown).toEqual({ x: 1 });
	});

	it("returns empty object and logs warning on malformed JSON", () => {
		writeConfig("this is not json {");
		const config = loadConfig();
		expect(config).toEqual({});
		expect(hoisted.logWarnCalls.some((c) => c.tag === "loadConfig")).toBe(true);
	});

	it("caches the result on subsequent calls", () => {
		writeConfig(JSON.stringify({ verify: { maxFiles: 10 } }));
		expect(loadConfig().verify?.maxFiles).toBe(10);
		// Change the underlying file -- cache must NOT pick it up
		writeConfig(JSON.stringify({ verify: { maxFiles: 999 } }));
		expect(loadConfig().verify?.maxFiles).toBe(10);
	});

	it("resets cache via _resetConfigCache so the new file is read", () => {
		writeConfig(JSON.stringify({ verify: { maxFiles: 10 } }));
		expect(loadConfig().verify?.maxFiles).toBe(10);
		writeConfig(JSON.stringify({ verify: { maxFiles: 999 } }));
		_resetConfigCache();
		expect(loadConfig().verify?.maxFiles).toBe(999);
	});
});

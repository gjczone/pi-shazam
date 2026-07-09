/**
 * Tests for loadConfig GBK support (#700).
 *
 * loadConfig must read `.pi-shazam/config.json` via readFileAdaptive so
 * GBK/GB2312-encoded files parse correctly. A UTF-8 readFileSync would
 * decode GBK bytes as mojibake and silently yield an empty config.
 *
 * We write a real GBK-encoded config file using iconv-lite and assert
 * loadConfig returns the parsed object (not the empty fallback).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as iconv from "iconv-lite";

const hoisted = {
	projectRoot: "",
};

vi.mock("../core/scanner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/scanner.js")>();
	return {
		...actual,
		getEffectiveRoot: () => hoisted.projectRoot,
	};
});

import { loadConfig, _resetConfigCache } from "../core/config.js";

let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "pi-shazam-config-gbk-"));
	mkdirSync(join(tmpRoot, ".pi-shazam"), { recursive: true });
	hoisted.projectRoot = tmpRoot;
	_resetConfigCache();
});

afterEach(() => {
	_resetConfigCache();
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadConfig GBK support", () => {
	it("reads a GBK-encoded config.json with Chinese values correctly", () => {
		// Embed a Chinese string inside the JSON value. Under a UTF-8
		// readFileSync the GBK bytes become mojibake and the value is
		// corrupted; readFileAdaptive must preserve it.
		const content = JSON.stringify({ label: "配置" });
		const gbkBytes = iconv.encode(content, "gbk");
		writeFileSync(join(tmpRoot, ".pi-shazam", "config.json"), gbkBytes);

		const cfg = loadConfig();
		expect(cfg.label).toBe("配置");
	});
});

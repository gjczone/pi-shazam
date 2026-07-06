/**
 * Regression tests for issue #629 sub-task 3: `shazam_impact` auto-infers
 * symbol vs files mode from the input shape.
 *
 * Before: `dispatchImpact` required either `--symbol` or `--files` and
 * returned a strict mutual-exclusion error when both were provided.
 * LLM agents commonly guessed wrong and wasted a turn on the error.
 *
 * After: a single inference helper (`inferImpactMode`) picks the mode:
 *   - explicit `--files` array -> files mode
 *   - both provided -> symbol wins, no error (silently drops --files)
 *   - `--symbol` looks like a path + file exists on disk + not in nameIndex
 *     -> files mode (single file)
 *   - otherwise -> symbol mode (downstream emits a clean "not found"
 *     error if the symbol doesn't exist)
 *
 * Tests target `inferImpactMode` directly so they don't need a live LSP
 * server and can construct deterministic file-existence conditions via
 * a tmp directory.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepoGraph, createSymbol, type RepoGraph } from "../core/graph.js";
import { inferImpactMode } from "../tools/_dispatchers.js";

describe("issue #629 / 3: inferImpactMode heuristic", () => {
	let tmp = "";
	let graph: RepoGraph = createRepoGraph();

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "impact-autoinfer-"));
		// Create a real on-disk file so the "looks like path + exists" branch
		// has something to match.
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src/exists.ts"), "export const x = 1;\n");
		writeFileSync(join(tmp, "src/other.ts"), "export const y = 2;\n");

		// Seed the graph with a symbol whose name is `scanProject` and
		// another whose name happens to match an extension regex.
		const scanProject = createSymbol("src/a.ts::scanProject::1", "scanProject", "function", "src/a.ts", 1);
		const configLike = createSymbol("src/config.ts::config.ts::1", "config.ts", "function", "src/config.ts", 1);
		graph.symbols.set(scanProject.id, scanProject);
		graph.symbols.set(configLike.id, configLike);
		const scanList = graph.nameIndex.get("scanProject") ?? [];
		scanList.push(scanProject);
		graph.nameIndex.set("scanProject", scanList);
		const configList = graph.nameIndex.get("config.ts") ?? [];
		configList.push(configLike);
		graph.nameIndex.set("config.ts", configList);
		graph.fileSymbols.set("src/a.ts", [scanProject.id]);
		graph.fileSymbols.set("src/config.ts", [configLike.id]);
	});

	afterAll(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it("error mode: neither --symbol nor --files", () => {
		const r = inferImpactMode(undefined, undefined, graph, tmp);
		expect(r.mode).toBe("error");
	});

	it("error mode: empty --files array and no --symbol", () => {
		const r = inferImpactMode(undefined, [], graph, tmp);
		expect(r.mode).toBe("error");
	});

	it("symbol mode: --symbol with name in nameIndex", () => {
		const r = inferImpactMode("scanProject", undefined, graph, tmp);
		expect(r.mode).toBe("symbol");
		expect(r.resolvedFiles).toBeUndefined();
	});

	it("files mode: --files array (explicit, no inference)", () => {
		const r = inferImpactMode(undefined, ["src/a.ts", "src/b.ts"], graph, tmp);
		expect(r.mode).toBe("files");
		expect(r.resolvedFiles).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("symbol mode wins when both are set (no strict-error)", () => {
		// Previously this branch returned an `isError: true` from
		// `dispatchImpact` -- #629 removes that wasted round-trip.
		const r = inferImpactMode("scanProject", ["src/a.ts"], graph, tmp);
		expect(r.mode).toBe("symbol");
	});

	it("files mode: --symbol looks like a path AND file exists AND not in nameIndex", () => {
		// `src/exists.ts` is on disk and not a graph symbol -> files mode.
		const r = inferImpactMode("src/exists.ts", undefined, graph, tmp);
		expect(r.mode).toBe("files");
		expect(r.resolvedFiles).toEqual(["src/exists.ts"]);
	});

	it("symbol mode: --symbol looks like a path but file does NOT exist", () => {
		// Path-like shape but no on-disk file -> falls through to symbol
		// mode, which downstream will report as "not found" cleanly.
		const r = inferImpactMode("src/missing.ts", undefined, graph, tmp);
		expect(r.mode).toBe("symbol");
	});

	it("symbol mode: --symbol matches extension regex but is NOT on disk AND NOT in nameIndex", () => {
		// The classic LLM mistake: a bare word ending in `.ts` with no
		// matching file or symbol. Must not trip the file-path branch.
		const r = inferImpactMode("phantom.ts", undefined, graph, tmp);
		expect(r.mode).toBe("symbol");
	});

	it("symbol mode: --symbol name IS in nameIndex even though it looks like a file", () => {
		// `config.ts` exists both as a graph symbol AND as a filename regex
		// match -- symbol wins because the nameIndex check precedes the
		// path-existence check (mirrors #616 logic in dispatchLookup).
		const r = inferImpactMode("config.ts", undefined, graph, tmp);
		expect(r.mode).toBe("symbol");
	});
});

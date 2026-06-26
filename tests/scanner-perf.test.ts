/**
 * Tests for issue #469: scanIncremental O(N×M) dependent detection and
 * removeFileData nameIndex O(N×M) cleanup.
 *
 * Verifies that:
 * - findDependentFiles returns direct importers (not transitive) via a
 *   reverse-import lookup, with correct union/dedup/empty/no-importer behavior
 * - removeFileData nameIndex cleanup removes entries when the deleted file
 *   held the last symbol of a name, and leaves other same-name symbols intact
 */
import { describe, it, expect } from "vitest";
import { createRepoGraph, createSymbol } from "../core/graph.js";
import type { RepoGraph } from "../core/graph.js";
import { findDependentFiles, removeFileData } from "../core/scanner.js";

// ── findDependentFiles ────────────────────────────────────────────────────

describe("Issue #469: findDependentFiles", () => {
	function buildGraphWithImports(
		fileImports: Map<string, string[]>,
	): RepoGraph {
		const graph = createRepoGraph();
		graph.fileImports = fileImports;
		return graph;
	}

	it("returns direct importers of a changed file", () => {
		const graph = buildGraphWithImports(
			new Map([
				["src/app.ts", ["src/math.ts"]],
				["src/lib.ts", ["src/math.ts"]],
				["src/utils.ts", []],
			]),
		);

		const deps = findDependentFiles(graph, ["src/math.ts"]);

		expect(deps.has("src/math.ts")).toBe(true);
		expect(deps.has("src/app.ts")).toBe(true);
		expect(deps.has("src/lib.ts")).toBe(true);
		expect(deps.has("src/utils.ts")).toBe(false);
	});

	it("does NOT include transitive importers (only direct)", () => {
		// app imports lib, lib imports math -- changing math should find lib
		// (direct importer) but NOT app (transitive, does not import math)
		const graph = buildGraphWithImports(
			new Map([
				["src/app.ts", ["src/lib.ts"]],
				["src/lib.ts", ["src/math.ts"]],
			]),
		);

		const deps = findDependentFiles(graph, ["src/math.ts"]);

		expect(deps.has("src/math.ts")).toBe(true);
		expect(deps.has("src/lib.ts")).toBe(true);
		// app.ts does not import math.ts directly -- must be excluded
		expect(deps.has("src/app.ts")).toBe(false);
	});

	it("returns only the changed file itself when no importers exist", () => {
		const graph = buildGraphWithImports(
			new Map([
				["src/app.ts", ["src/lib.ts"]],
				["src/lib.ts", []],
			]),
		);

		const deps = findDependentFiles(graph, ["src/app.ts"]);

		expect(deps.size).toBe(1);
		expect(deps.has("src/app.ts")).toBe(true);
	});

	it("returns empty set for empty changedFiles input", () => {
		const graph = buildGraphWithImports(
			new Map([["src/app.ts", ["src/lib.ts"]]]),
		);

		const deps = findDependentFiles(graph, []);

		expect(deps.size).toBe(0);
	});

	it("unions importers across multiple changed files", () => {
		const graph = buildGraphWithImports(
			new Map([
				["src/a.ts", ["src/math.ts"]],
				["src/b.ts", ["src/utils.ts"]],
				["src/c.ts", ["src/math.ts", "src/utils.ts"]],
			]),
		);

		const deps = findDependentFiles(graph, ["src/math.ts", "src/utils.ts"]);

		expect(deps.has("src/math.ts")).toBe(true);
		expect(deps.has("src/utils.ts")).toBe(true);
		expect(deps.has("src/a.ts")).toBe(true);
		expect(deps.has("src/b.ts")).toBe(true);
		expect(deps.has("src/c.ts")).toBe(true);
	});

	it("deduplicates importers that import multiple changed files", () => {
		// c.ts imports both math.ts and utils.ts -- when both change,
		// c.ts must appear only once in the result set
		const graph = buildGraphWithImports(
			new Map([
				["src/c.ts", ["src/math.ts", "src/utils.ts"]],
			]),
		);

		const deps = findDependentFiles(graph, ["src/math.ts", "src/utils.ts"]);

		expect(deps.size).toBe(3); // math, utils, c (c counted once)
		expect(deps.has("src/c.ts")).toBe(true);
	});
});

// ── removeFileData nameIndex cleanup ──────────────────────────────────────

describe("Issue #469: removeFileData nameIndex cleanup", () => {
	/**
	 * Build a minimal graph with symbols in the given file, plus optional
	 * same-name symbols in other files. Wires up fileSymbols, nameIndex,
	 * and targetToSources so removeFileData can mutate them correctly.
	 */
	function buildGraphForRemove(
		file: string,
		symbolsInFile: { id: string; name: string; kind: string; line: number }[],
		otherSymbols: { id: string; name: string; kind: string; file: string; line: number }[] = [],
	): RepoGraph {
		const graph = createRepoGraph();
		const fileSymIds: string[] = [];

		for (const s of symbolsInFile) {
			const sym = createSymbol(s.id, s.name, s.kind, file, s.line);
			graph.symbols.set(s.id, sym);
			fileSymIds.push(s.id);
			const named = graph.nameIndex.get(s.name) ?? [];
			named.push(sym);
			graph.nameIndex.set(s.name, named);
		}
		graph.fileSymbols.set(file, fileSymIds);

		for (const s of otherSymbols) {
			const sym = createSymbol(s.id, s.name, s.kind, s.file, s.line);
			graph.symbols.set(s.id, sym);
			const named = graph.nameIndex.get(s.name) ?? [];
			named.push(sym);
			graph.nameIndex.set(s.name, named);
			const otherFileSyms = graph.fileSymbols.get(s.file) ?? [];
			otherFileSyms.push(s.id);
			graph.fileSymbols.set(s.file, otherFileSyms);
		}

		return graph;
	}

	it("removes nameIndex entry when the deleted file held the last symbol of that name", () => {
		const graph = buildGraphForRemove(
			"src/math.ts",
			[{ id: "src/math.ts::add::1", name: "add", kind: "function", line: 1 }],
		);

		expect(graph.nameIndex.has("add")).toBe(true);
		expect(graph.nameIndex.get("add")!.length).toBe(1);

		removeFileData(graph, "src/math.ts");

		expect(graph.nameIndex.has("add")).toBe(false);
		expect(graph.symbols.has("src/math.ts::add::1")).toBe(false);
		expect(graph.fileSymbols.has("src/math.ts")).toBe(false);
	});

	it("leaves other symbols with the same name unaffected", () => {
		const graph = buildGraphForRemove(
			"src/math.ts",
			[{ id: "src/math.ts::add::1", name: "add", kind: "function", line: 1 }],
			[
				{ id: "src/utils.ts::add::5", name: "add", kind: "function", file: "src/utils.ts", line: 5 },
			],
		);

		expect(graph.nameIndex.get("add")!.length).toBe(2);

		removeFileData(graph, "src/math.ts");

		// nameIndex still has "add" but only the utils.ts symbol
		expect(graph.nameIndex.has("add")).toBe(true);
		expect(graph.nameIndex.get("add")!.length).toBe(1);
		expect(graph.nameIndex.get("add")![0]!.id).toBe("src/utils.ts::add::5");
		expect(graph.symbols.has("src/math.ts::add::1")).toBe(false);
		expect(graph.symbols.has("src/utils.ts::add::5")).toBe(true);
	});

	it("deduplicates name cleanup when the file has multiple symbols sharing a name", () => {
		// Two symbols in the same file share the name "handler" -- the cleanup
		// must filter the nameIndex once (not twice), removing both IDs.
		const graph = buildGraphForRemove(
			"src/handlers.ts",
			[
				{ id: "src/handlers.ts::handler::1", name: "handler", kind: "function", line: 1 },
				{ id: "src/handlers.ts::handler::10", name: "handler", kind: "function", line: 10 },
			],
			[
				{ id: "src/other.ts::handler::3", name: "handler", kind: "function", file: "src/other.ts", line: 3 },
			],
		);

		expect(graph.nameIndex.get("handler")!.length).toBe(3);

		removeFileData(graph, "src/handlers.ts");

		// Both handlers.ts symbols removed; other.ts handler remains
		expect(graph.nameIndex.has("handler")).toBe(true);
		expect(graph.nameIndex.get("handler")!.length).toBe(1);
		expect(graph.nameIndex.get("handler")![0]!.id).toBe("src/other.ts::handler::3");
	});

	it("removes multiple distinct names from nameIndex", () => {
		const graph = buildGraphForRemove(
			"src/math.ts",
			[
				{ id: "src/math.ts::add::1", name: "add", kind: "function", line: 1 },
				{ id: "src/math.ts::sub::5", name: "sub", kind: "function", line: 5 },
			],
		);

		expect(graph.nameIndex.has("add")).toBe(true);
		expect(graph.nameIndex.has("sub")).toBe(true);

		removeFileData(graph, "src/math.ts");

		expect(graph.nameIndex.has("add")).toBe(false);
		expect(graph.nameIndex.has("sub")).toBe(false);
	});
});

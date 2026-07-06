/**
 * Tests for shazam_lookup mode=state removal (#630 cleanup).
 *
 * PR-E (commit 41a6e47) added a deprecation warning for mode=state and
 * kept the function working. This commit removes the function entirely:
 * passing mode=state now returns a clean error pointing the caller at
 * the supported --name lookup path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	logWarnCalls: [] as Array<{ tag: string; message: string; err?: unknown }>,
}));

vi.mock("../core/output.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/output.js")>();
	return {
		...actual,
		_logWarn: (tag: string, message: string, err?: unknown) => {
			hoisted.logWarnCalls.push({ tag, message, err });
		},
		_logInternal: () => {},
	};
});

import { dispatchLookup } from "../tools/_dispatchers.js";
import type { RepoGraph } from "../core/graph.js";

function emptyGraph(): RepoGraph {
	return {
		symbols: new Map(),
		fileSymbols: new Map(),
		nameIndex: new Map(),
		incoming: new Map(),
		outgoing: new Map(),
		fileImports: new Map(),
		fileCalls: new Map(),
		fileRefs: new Map(),
		fileTypeRefs: new Map(),
		fileImportBindings: new Map(),
		targetToSources: new Map(),
	};
}

describe("shazam_lookup mode=state removal (#630 cleanup)", () => {
	beforeEach(() => {
		hoisted.logWarnCalls = [];
	});

	it("returns an error when mode=state is used", async () => {
		const graph = emptyGraph();
		const result = await dispatchLookup(graph, { name: "Status", mode: "state" }, "/tmp");
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(
			/mode=state.*removed|mode=state.*no longer supported|state map analysis is not available/i,
		);
	});

	it("does NOT call any state-map function on mode=state (no executeStateMap side effects)", async () => {
		const graph = emptyGraph();
		graph.symbols.set("Status:src/enums.ts:1:1", {
			id: "Status:src/enums.ts:1:1",
			name: "Status",
			kind: "enum",
			file: "src/enums.ts",
			line: 1,
			endLine: 5,
			col: 1,
			visibility: "exported",
			signature: "enum Status",
			pagerank: 0,
			docstring: undefined,
		});
		graph.nameIndex.set("Status", ["Status:src/enums.ts:1:1"]);
		graph.fileSymbols.set("src/enums.ts", ["Status:src/enums.ts:1:1"]);

		const result = await dispatchLookup(graph, { name: "Status", mode: "state" }, "/tmp");
		expect(result.isError).toBe(true);
		// Output should NOT contain the "State Map:" header that the old
		// function would have produced.
		expect(result.text).not.toMatch(/State Map:/);
	});

	it("does not affect default mode (no mode param)", async () => {
		const graph = emptyGraph();
		// Symbol not found -> regular "Symbol not found" error
		const result = await dispatchLookup(graph, { name: "NonExistent" }, "/tmp");
		expect(result.isError).toBeFalsy();
		expect(result.text).toMatch(/Symbol not found/);
	});

	it("does not affect mode=search", async () => {
		const graph = emptyGraph();
		const result = await dispatchLookup(graph, { name: "NonExistent", mode: "search" }, "/tmp");
		// search mode returns the standard "No matching symbols found" output
		// (not an error)
		expect(result.text).toMatch(/No matching symbols found|Concept Search/i);
	});
});

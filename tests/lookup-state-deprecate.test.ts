/**
 * Tests for shazam_lookup mode=state deprecation warning (#630).
 *
 * The `state` mode of shazam_lookup was used to generate enum/class/interface
 * state maps. It is unused by current call sites and is being deprecated.
 * For now the function still works, but a deprecation warning is logged
 * so users and tests see the migration signal.
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

// Provide a minimal graph. dispatchLookup only needs graph.nameIndex and
// graph.symbols; mode=state never dereferences the graph for missing
// symbols (executeStateMap handles that case internally).
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
	};
}

describe("shazam_lookup mode=state deprecation (#630)", () => {
	beforeEach(() => {
		hoisted.logWarnCalls = [];
	});

	it("emits a deprecation warning when mode=state is used", async () => {
		const graph = emptyGraph();
		// Symbol not found -> executeStateMap returns the "Symbol not found"
		// error message. We do not care about the output, only the warning.
		const result = await dispatchLookup(graph, { name: "NonExistent", mode: "state" }, "/tmp");

		expect(result.isError).toBeFalsy();
		const deprecationWarn = hoisted.logWarnCalls.find(
			(c) => c.tag === "shazam_lookup" && /deprecated/i.test(c.message),
		);
		expect(deprecationWarn).toBeDefined();
	});

	it("does NOT emit a deprecation warning for mode=search", async () => {
		const graph = emptyGraph();
		await dispatchLookup(graph, { name: "NonExistent", mode: "search" }, "/tmp");
		const deprecationWarn = hoisted.logWarnCalls.find(
			(c) => c.tag === "shazam_lookup" && /deprecated/i.test(c.message),
		);
		expect(deprecationWarn).toBeUndefined();
	});

	it("does NOT emit a deprecation warning for default mode (no mode param)", async () => {
		const graph = emptyGraph();
		await dispatchLookup(graph, { name: "NonExistent" }, "/tmp");
		const deprecationWarn = hoisted.logWarnCalls.find(
			(c) => c.tag === "shazam_lookup" && /deprecated/i.test(c.message),
		);
		expect(deprecationWarn).toBeUndefined();
	});

	it("keeps the state map functional (functional deprecation, not removal)", async () => {
		// Build a graph with one enum symbol so executeStateMap succeeds
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

		// State map output should be present in the result text
		expect(result.text).toMatch(/State Map/);
		// AND the deprecation warning is still emitted
		expect(
			hoisted.logWarnCalls.some(
				(c) => c.tag === "shazam_lookup" && /deprecated/i.test(c.message),
			),
		).toBe(true);
	});
});

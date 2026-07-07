/**
 * Tests for issue #666: dispatchImpact records the rename safety gate
 * (recordCallChain) unconditionally for symbol mode, before checking the
 * symbol exists. A non-existent symbol must NOT satisfy the
 * shazam_rename_symbol gate via a phantom call (reopens #569).
 *
 * The guard mirrors the one already present in executeCallChain: only call
 * recordCallChain when graph.nameIndex resolves >= 1 symbol.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRepoGraph } from "../core/graph.js";
import { dispatchImpact } from "../tools/_dispatchers.js";
import { hasCallChainChecked, clearRenameState } from "../tools/rename-state.js";
import type { RepoGraph } from "../core/graph.js";

describe("issue #666: dispatchImpact rename gate requires symbol existence", () => {
	beforeEach(() => {
		clearRenameState();
	});

	it("does NOT record the rename gate for a non-existent symbol", () => {
		const graph: RepoGraph = createRepoGraph();
		dispatchImpact(graph, { symbol: "doesNotExistAnywhere" }, "/tmp");
		expect(hasCallChainChecked("doesNotExistAnywhere")).toBe(false);
	});

	it("records the rename gate for a symbol that resolves in nameIndex", () => {
		const graph: RepoGraph = createRepoGraph();
		graph.nameIndex.set("realFunc", [
			{
				id: "a.ts::realFunc::1",
				name: "realFunc",
				file: "a.ts",
				line: 1,
				kind: "function",
				visibility: "public",
				provenance: "heuristic",
			} as never,
		]);
		dispatchImpact(graph, { symbol: "realFunc" }, "/tmp");
		expect(hasCallChainChecked("realFunc")).toBe(true);
	});
});

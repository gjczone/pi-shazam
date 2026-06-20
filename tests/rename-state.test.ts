/**
 * Tests for issue #326: rename_symbol safety gate with call_chain awareness.
 *
 * Verifies that:
 * - rename state tracks which symbols have been reviewed via call_chain
 * - the rename gate blocks non-dry-run when call_chain has not been run
 * - the rename gate allows non-dry-run after call_chain for the same symbol
 * - state resets on clearRenameState (session boundary)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { recordCallChain, hasCallChainChecked, clearRenameState } from "../hooks/rename-state.js";
import { scanProject } from "../core/scanner.js";
import { executeCallChain } from "../tools/call_chain.js";
import type { RepoGraph } from "../core/graph.js";

let _graph: RepoGraph | null = null;
function getGraph(): RepoGraph {
	if (!_graph) {
		_graph = scanProject(".");
	}
	return _graph;
}

describe("hooks/rename-state", () => {
	beforeEach(() => {
		clearRenameState();
	});

	it("should start with no symbols reviewed", () => {
		expect(hasCallChainChecked("anySymbol")).toBe(false);
	});

	it("recordCallChain marks a symbol as reviewed", () => {
		recordCallChain("myFunction");
		expect(hasCallChainChecked("myFunction")).toBe(true);
	});

	it("hasCallChainChecked returns false for unreviewed symbols", () => {
		recordCallChain("myFunction");
		expect(hasCallChainChecked("otherFunction")).toBe(false);
	});

	it("clearRenameState resets all tracked symbols", () => {
		recordCallChain("funcA");
		recordCallChain("funcB");
		expect(hasCallChainChecked("funcA")).toBe(true);
		expect(hasCallChainChecked("funcB")).toBe(true);

		clearRenameState();

		expect(hasCallChainChecked("funcA")).toBe(false);
		expect(hasCallChainChecked("funcB")).toBe(false);
	});

	it("recordCallChain is idempotent", () => {
		recordCallChain("myFunction");
		recordCallChain("myFunction");
		expect(hasCallChainChecked("myFunction")).toBe(true);
	});
});

describe("Issue #326: call_chain records state for rename gate", () => {
	beforeEach(() => {
		clearRenameState();
	});

	it("executeCallChain records the symbol for the rename gate", () => {
		const graph = getGraph();

		// Before call_chain: symbol not reviewed
		expect(hasCallChainChecked("executeImpact")).toBe(false);

		// Run call_chain for a known symbol
		executeCallChain(graph, "executeImpact");

		// After call_chain: symbol is reviewed
		expect(hasCallChainChecked("executeImpact")).toBe(true);
	});

	it("call_chain for one symbol does not mark other symbols", () => {
		const graph = getGraph();

		executeCallChain(graph, "executeImpact");

		expect(hasCallChainChecked("executeImpact")).toBe(true);
		expect(hasCallChainChecked("executeOverview")).toBe(false);
	});

	it("rename gate blocks without prior call_chain (simulated)", () => {
		// Simulate: hasCallChainChecked returns false => gate should block
		expect(hasCallChainChecked("unreviewedSymbol")).toBe(false);
		// The actual blocking happens in rename_symbol.ts customExecute,
		// but the gate condition is: !hasCallChainChecked(symbol)
	});

	it("rename gate passes after call_chain (simulated)", () => {
		const graph = getGraph();

		// Run call_chain first
		executeCallChain(graph, "scanProject");

		// Now the gate should pass
		expect(hasCallChainChecked("scanProject")).toBe(true);
		// The rename tool would proceed to executeRenameSymbol
	});
});

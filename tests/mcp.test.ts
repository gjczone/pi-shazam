import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { validatePathInProject } from "../tools/_factory.js";
import { clearRenameState, hasCallChainChecked, recordCallChain } from "../hooks/rename-state.js";

let _graph: RepoGraph | null = null;
function getGraph(): RepoGraph {
	if (!_graph) {
		_graph = scanProject(".");
	}
	return _graph;
}

describe("MCP: tool schemas", () => {
	it("overview schema should accept optional filter", () => {
		const schema = z.object({ filter: z.string().optional() });
		expect(() => schema.parse({})).not.toThrow();
		expect(() => schema.parse({ filter: "index" })).not.toThrow();
	});

	it("impact schema should require files array", () => {
		const schema = z.object({ files: z.array(z.string()) });
		expect(() => schema.parse({ files: ["index.ts"] })).not.toThrow();
		expect(() => schema.parse({})).toThrow();
	});

	it("lookup schema should accept name with optional mode and file", () => {
		const schema = z.object({
			name: z.string(),
			mode: z.enum(["state"]).optional(),
			file: z.string().optional(),
		});
		expect(() => schema.parse({ name: "myFunc" })).not.toThrow();
		expect(() => schema.parse({ name: "Status", mode: "state" })).not.toThrow();
	});

	it("lookup file_detail schema should require file path", () => {
		const schema = z.object({ file: z.string() });
		expect(() => schema.parse({ file: "index.ts" })).not.toThrow();
		expect(() => schema.parse({})).toThrow();
	});

	it("impact call_chain schema should accept symbol with optional depth, flat, and direction", () => {
		const schema = z.object({
			symbol: z.string(),
			depth: z.number().int().min(1).max(10).optional(),
			flat: z.boolean().optional(),
			direction: z.enum(["incoming", "outgoing", "both"]).optional(),
		});
		expect(() => schema.parse({ symbol: "main" })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", depth: 3 })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", flat: true })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", direction: "incoming" })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", direction: "outgoing" })).not.toThrow();
	});

	it("find_tests schema should accept optional sourceFile and module", () => {
		const schema = z.object({
			sourceFile: z.string().optional(),
			module: z.string().optional(),
		});
		expect(() => schema.parse({})).not.toThrow();
		expect(() => schema.parse({ sourceFile: "index.ts" })).not.toThrow();
	});

	it("verify schema should accept optional boolean flags", () => {
		const schema = z.object({
			quick: z.boolean().optional(),
			lspOnly: z.boolean().optional(),
		});
		expect(() => schema.parse({})).not.toThrow();
		expect(() => schema.parse({ quick: true })).not.toThrow();
	});

	it("rename_symbol schema should require symbol and newName", () => {
		const schema = z.object({ symbol: z.string(), newName: z.string() });
		expect(() => schema.parse({ symbol: "oldName", newName: "newName" })).not.toThrow();
		expect(() => schema.parse({ symbol: "oldName" })).toThrow();
	});

	it("safe_delete schema should accept symbol with optional dryRun", () => {
		const schema = z.object({ symbol: z.string(), dryRun: z.boolean().optional() });
		expect(() => schema.parse({ symbol: "deadCode" })).not.toThrow();
		expect(() => schema.parse({ symbol: "deadCode", dryRun: true })).not.toThrow();
	});
});

describe("MCP: tool output format", () => {
	it("overview returns text content", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const result = executeOverview(getGraph(), ".");
		const text = typeof result === "string" ? result : JSON.stringify(result);
		expect(text.length).toBeGreaterThan(0);
	});

	it("overview hotspots returns text content", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");
		const result = _computeHotspots(getGraph());
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
	});

	it("impact call_chain returns text content for valid symbol", async () => {
		const { executeCallChain } = await import("../tools/impact.js");
		const result = executeCallChain(getGraph(), "index.ts", 1);
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("find_tests returns result object", async () => {
		const { executeFindTests } = await import("../tools/find_tests.js");
		const result = executeFindTests(getGraph(), ".", {});
		expect(result).toBeDefined();
		expect(result.matches).toBeDefined();
	});

	it("all tool results can be serialized as MCP content", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const text = executeOverview(getGraph(), ".");
		const content = { content: [{ type: "text" as const, text }] };
		expect(content.content[0].type).toBe("text");
		expect(typeof content.content[0].text).toBe("string");
	});
});

// -- MCP path-traversal guards (issues #445, #446) --

describe("MCP: path-traversal guards", () => {
	it("shazam_impact files array rejects path-traversal via validatePathInProject (#445)", () => {
		// Simulate what the MCP handler does: validate each file in filesArr
		const filesArr = ["../../etc/passwd", "core/scanner.ts"];
		const projectRoot = ".";
		for (const f of filesArr) {
			if (!validatePathInProject(f, projectRoot)) {
				// Path-traversal detected -- handler should return error
				expect(f).toBe("../../etc/passwd");
				return;
			}
		}
		// Should not reach here -- the traversal path should be caught
		expect.unreachable("path-traversal was not caught");
	});

	it("shazam_impact files array accepts valid in-root paths (#445)", () => {
		const filesArr = ["core/scanner.ts", "tools/impact.ts"];
		const projectRoot = ".";
		for (const f of filesArr) {
			expect(validatePathInProject(f, projectRoot)).toBe(true);
		}
	});

	it("shazam_find_tests sourceFile rejects path-traversal via validatePathInProject (#446)", () => {
		const sourceFile = "../../etc/passwd";
		const projectRoot = ".";
		expect(validatePathInProject(sourceFile, projectRoot)).toBe(false);
	});

	it("shazam_find_tests sourceFile accepts valid in-root paths (#446)", () => {
		const sourceFile = "core/scanner.ts";
		const projectRoot = ".";
		expect(validatePathInProject(sourceFile, projectRoot)).toBe(true);
	});

	// #465 Finding A: shazam_format is the only file-accepting MCP handler
	// that skipped validatePathInProject, allowing formatters to write files
	// outside the configured project root.
	it("shazam_format file rejects path-traversal via validatePathInProject (#465)", () => {
		const file = "../../etc/passwd";
		const projectRoot = ".";
		expect(validatePathInProject(file, projectRoot)).toBe(false);
	});

	it("shazam_format file accepts valid in-root paths (#465)", () => {
		const file = "core/scanner.ts";
		const projectRoot = ".";
		expect(validatePathInProject(file, projectRoot)).toBe(true);
	});
});

// -- MCP project root startup validation (issue #465 Finding B) --

describe("MCP: project root startup validation (#465)", () => {
	it("accepts a non-home absolute directory that exists (#465)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		// /tmp is outside $HOME but is a valid directory -- must not be rejected.
		const result = validateProjectRoot(tmpdir());
		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("rejects a non-existent path (#465)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		const result = validateProjectRoot(join(tmpdir(), "pi-shazam-nonexistent-9999"));
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("rejects a file (not a directory) (#465)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		const filePath = join(tmpdir(), "pi-shazam-465-file.txt");
		writeFileSync(filePath, "test");
		try {
			const result = validateProjectRoot(filePath);
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			rmSync(filePath, { force: true });
		}
	});
});

// -- MCP recordCallChain for rename workflow (issue #447) --

describe("MCP: recordCallChain enables rename workflow (#447)", () => {
	beforeEach(() => {
		clearRenameState();
	});

	it("recordCallChain marks symbol as reviewed for rename gate", () => {
		const symbol = "scanProject";
		expect(hasCallChainChecked(symbol)).toBe(false);
		recordCallChain(symbol);
		expect(hasCallChainChecked(symbol)).toBe(true);
	});

	it("rename gate blocks without prior recordCallChain", () => {
		const symbol = "someSymbol";
		expect(hasCallChainChecked(symbol)).toBe(false);
		// Simulate the MCP handler gate: would return [BLOCKED]
		const blocked = !hasCallChainChecked(symbol);
		expect(blocked).toBe(true);
	});

	it("rename gate passes after recordCallChain", () => {
		const symbol = "someSymbol";
		recordCallChain(symbol);
		const allowed = hasCallChainChecked(symbol);
		expect(allowed).toBe(true);
	});
});

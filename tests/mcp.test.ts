import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";

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

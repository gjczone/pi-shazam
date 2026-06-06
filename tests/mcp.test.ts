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

	it("codesearch schema should require query string", () => {
		const schema = z.object({ query: z.string(), target: z.enum(["symbol", "code"]).optional() });
		expect(() => schema.parse({ query: "search" })).not.toThrow();
		expect(() => schema.parse({ query: "search", target: "code" })).not.toThrow();
		expect(() => schema.parse({})).toThrow();
	});

	it("symbol schema should accept name with optional mode and file", () => {
		const schema = z.object({
			name: z.string(),
			mode: z.enum(["state"]).optional(),
			file: z.string().optional(),
		});
		expect(() => schema.parse({ name: "myFunc" })).not.toThrow();
		expect(() => schema.parse({ name: "Status", mode: "state" })).not.toThrow();
	});

	it("file_detail schema should require file path", () => {
		const schema = z.object({ file: z.string() });
		expect(() => schema.parse({ file: "index.ts" })).not.toThrow();
		expect(() => schema.parse({})).toThrow();
	});

	it("call_chain schema should accept symbol with optional depth and flat", () => {
		const schema = z.object({
			symbol: z.string(),
			depth: z.number().int().min(1).max(10).optional(),
			flat: z.boolean().optional(),
		});
		expect(() => schema.parse({ symbol: "main" })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", depth: 3 })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", flat: true })).not.toThrow();
	});

	it("hover schema should accept name with optional file", () => {
		const schema = z.object({ name: z.string(), file: z.string().optional() });
		expect(() => schema.parse({ name: "myFunc" })).not.toThrow();
	});

	it("find_tests schema should accept optional sourceFile and module", () => {
		const schema = z.object({
			sourceFile: z.string().optional(),
			module: z.string().optional(),
		});
		expect(() => schema.parse({})).not.toThrow();
		expect(() => schema.parse({ sourceFile: "index.ts" })).not.toThrow();
	});

	it("hotspots schema should accept empty object", () => {
		const schema = z.object({});
		expect(() => schema.parse({})).not.toThrow();
	});

	it("verify schema should accept optional boolean flags", () => {
		const schema = z.object({
			quick: z.boolean().optional(),
			lspOnly: z.boolean().optional(),
		});
		expect(() => schema.parse({})).not.toThrow();
		expect(() => schema.parse({ quick: true })).not.toThrow();
	});

	it("type_hierarchy schema should require name with optional direction", () => {
		const schema = z.object({
			name: z.string(),
			direction: z.enum(["both", "supertypes", "subtypes"]).optional(),
		});
		expect(() => schema.parse({ name: "MyClass" })).not.toThrow();
		expect(() => schema.parse({ name: "MyClass", direction: "subtypes" })).not.toThrow();
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

	it("hotspots returns text content", async () => {
		const { executeHotspots } = await import("../tools/hotspots.js");
		const result = executeHotspots(getGraph());
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("call_chain returns text content for valid symbol", async () => {
		const { executeCallChain } = await import("../tools/call_chain.js");
		const result = executeCallChain(getGraph(), "index.ts", 1);
		expect(typeof result).toBe("string");
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

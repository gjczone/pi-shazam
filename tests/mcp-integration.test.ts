/**
 * MCP integration tests — exercise the full scan → analyze → format pipeline
 * using the project's own codebase as the test fixture.
 *
 * These tests call the actual tool execute functions directly (not mocked)
 * and verify the output format matches the expected MCP content envelope.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";

// Shared graph — built once from the project's own codebase
let graph: RepoGraph;

beforeAll(() => {
	graph = scanProject(".");
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Assert MCP content envelope: { content: [{ type: "text", text: string }] } */
function assertMcpEnvelope(result: { content: { type: string; text: string }[] }): void {
	expect(result).toBeDefined();
	expect(result.content).toBeDefined();
	expect(Array.isArray(result.content)).toBe(true);
	expect(result.content.length).toBeGreaterThan(0);
	expect(result.content[0]!.type).toBe("text");
	expect(typeof result.content[0]!.text).toBe("string");
	expect(result.content[0]!.text.length).toBeGreaterThan(0);
}

/** Wrap a plain-text tool result into the MCP content envelope shape. */
function wrapMcp(text: string): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text }] };
}

// ── Integration: overview → MCP envelope ─────────────────────────────────

describe("MCP integration: overview pipeline", () => {
	it("should produce valid MCP content from overview (text mode)", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const text = executeOverview(graph, ".");
		const envelope = wrapMcp(text);
		assertMcpEnvelope(envelope);
		expect(text).toMatch(/Project Overview/i);
		expect(text).toMatch(/Top.*Files.*PageRank/i);
	});

	it("should produce valid JSON envelope from overview (json mode)", async () => {
		const { executeOverviewJson } = await import("../tools/overview.js");
		const jsonText = executeOverviewJson(graph, ".");
		const parsed = JSON.parse(jsonText);
		expect(parsed.schema_version).toBe("1.0");
		expect(parsed.command).toBe("overview");
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBeDefined();
		expect(parsed.result.totalSymbols).toBeGreaterThan(0);
		expect(Array.isArray(parsed.result.topFiles)).toBe(true);

		// Verify it can be wrapped in MCP envelope
		const envelope = { content: [{ type: "text" as const, text: jsonText }] };
		assertMcpEnvelope(envelope);
	});

	it("should include key dependencies in overview output", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const text = executeOverview(graph, ".");
		expect(text).toMatch(/### Key Dependencies/);
	});

	it("should include recent changes in overview output", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const text = executeOverview(graph, ".");
		expect(text).toMatch(/### Recent Changes/);
	});

	it("should support filter mode and return matching files", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const text = executeOverview(graph, ".", "scanner");
		expect(text).toMatch(/scanner/);
	});
});

// ── Integration: hotspots → MCP envelope ─────────────────────────────────

describe("MCP integration: hotspots pipeline", () => {
	it("should produce valid MCP content from hotspots", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");
		const result = _computeHotspots(graph);
		const text = JSON.stringify(result);
		const envelope = wrapMcp(text);
		assertMcpEnvelope(envelope);
		expect(Array.isArray(result)).toBe(true);
	});

	it("should produce valid JSON envelope from hotspots", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");
		const hotspots = _computeHotspots(graph, 5);
		const jsonText = JSON.stringify({ schema_version: "1.0", command: "overview", status: "ok", result: { hotspots } });
		const parsed = JSON.parse(jsonText);
		expect(parsed.schema_version).toBe("1.0");
		expect(parsed.command).toBe("overview");
		expect(parsed.status).toBe("ok");
		expect(parsed.result.hotspots).toBeDefined();
		expect(Array.isArray(parsed.result.hotspots)).toBe(true);
		expect(parsed.result.hotspots.length).toBeLessThanOrEqual(5);

		// Each hotspot should have required fields
		for (const h of parsed.result.hotspots) {
			expect(typeof h.file).toBe("string");
			expect(typeof h.symbolCount).toBe("number");
			expect(typeof h.hotspotScore).toBe("number");
		}
	});

	it("should respect topN parameter", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");
		const result = _computeHotspots(graph, 3);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeLessThanOrEqual(3);
	});

	it("should exclude config/generated files from results", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");
		const result = _computeHotspots(graph, 20);
		expect(result).not.toContainEqual(expect.objectContaining({ file: expect.stringMatching(/package-lock\.json/) }));
		expect(result).not.toContainEqual(expect.objectContaining({ file: expect.stringMatching(/node_modules/) }));
	});
});

// ── Integration: impact → MCP envelope ───────────────────────────────────

describe("MCP integration: impact pipeline", () => {
	it("should produce valid text from impact analysis", async () => {
		const { executeImpact } = await import("../tools/impact.js");
		const text = executeImpact(graph, ["core/scanner.ts"]);
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
		const envelope = wrapMcp(text);
		assertMcpEnvelope(envelope);
	});

	it("should mention affected files in impact output", async () => {
		const { executeImpact } = await import("../tools/impact.js");
		const text = executeImpact(graph, ["core/graph.ts"]);
		expect(text).toMatch(/impact|affected|file|symbol/i);
	});
});

// ── Integration: symbol → MCP envelope ───────────────────────────────────

describe("MCP integration: symbol pipeline", () => {
	it("should produce valid text from symbol lookup", async () => {
		const { _findSymbols } = await import("../tools/lookup.js");
		const result = _findSymbols(graph, "scanProject");
		const text = JSON.stringify(result);
		expect(typeof text).toBe("string");
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
		const envelope = wrapMcp(text);
		assertMcpEnvelope(envelope);
	});
});

// ── Integration: verify → MCP envelope ───────────────────────────────────

describe("MCP integration: verify pipeline", () => {
	it("should produce valid text from verify", async () => {
		const { executeVerify } = await import("../tools/verify.js");
		const text = executeVerify(graph, ".");
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
		const envelope = wrapMcp(text);
		assertMcpEnvelope(envelope);
	});

	it("should support quick mode", async () => {
		const { executeVerify } = await import("../tools/verify.js");
		const text = executeVerify(graph, ".", { quick: true });
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
	});
});

// ── Integration: file_detail → MCP envelope ──────────────────────────────

describe("MCP integration: file_detail pipeline", () => {
	it("should produce valid text from file_detail", async () => {
		const { _executeFileDetail } = await import("../tools/lookup.js");
		const text = _executeFileDetail(graph, "core/graph.ts");
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
		expect(text).toMatch(/Symbol|symbol/i);
		const envelope = wrapMcp(text);
		assertMcpEnvelope(envelope);
	});
});

// ── Integration: call_chain → MCP envelope ───────────────────────────────

describe("MCP integration: impact call_chain pipeline", () => {
	it("should produce valid text from impact call_chain", async () => {
		const { executeCallChain } = await import("../tools/impact.js");
		const text = executeCallChain(graph, "scanProject", 1);
		expect(typeof text).toBe("string");
		const envelope = wrapMcp(text);
		assertMcpEnvelope(envelope);
	});
});

// ── Integration: find_tests → MCP envelope ───────────────────────────────

describe("MCP integration: find_tests pipeline", () => {
	it("should produce valid result from find_tests", async () => {
		const { executeFindTests } = await import("../tools/find_tests.js");
		const result = executeFindTests(graph, ".", {});
		expect(result).toBeDefined();
		expect(result.matches).toBeDefined();
		expect(Array.isArray(result.matches)).toBe(true);
	});
});

// ── Integration: fix → MCP envelope ──────────────────────────────────────

describe("MCP integration: fix pipeline", () => {
	it("should produce valid text from fix in dry-run mode", async () => {
		const { executeFormat } = await import("../tools/format.js");
		const text = executeFormat(graph, ".", { dryRun: true });
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
		const envelope = wrapMcp(text);
		assertMcpEnvelope(envelope);
	});
});

// ── End-to-end: simulate MCP handler pattern ─────────────────────────────

describe("MCP integration: end-to-end handler simulation", () => {
	it("should simulate the MCP overview handler pattern", async () => {
		const { executeOverview } = await import("../tools/overview.js");

		// Simulate what mcp/tools.ts does: call execute, wrap in content array
		const text = executeOverview(graph, ".");
		const mcpResult = { content: [{ type: "text" as const, text }] };

		assertMcpEnvelope(mcpResult);
		// The text should be serializable to JSON (MCP sends JSON-RPC)
		const serialized = JSON.stringify(mcpResult);
		expect(serialized.length).toBeGreaterThan(0);
		const deserialized = JSON.parse(serialized);
		assertMcpEnvelope(deserialized);
	});

	it("should simulate the MCP hotspots handler pattern", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");

		const hotspots = _computeHotspots(graph);
		const text = JSON.stringify(hotspots);
		const mcpResult = { content: [{ type: "text" as const, text }] };

		assertMcpEnvelope(mcpResult);
		const serialized = JSON.stringify(mcpResult);
		const deserialized = JSON.parse(serialized);
		assertMcpEnvelope(deserialized);
	});

	// codesearch removed in #362
	it.skip("should simulate the MCP codesearch handler pattern", async () => {
		const { executeCodesearch } = await import("../tools/codesearch.js");

		// MCP codesearch serializes results as JSON
		const scored = executeCodesearch(graph, "scan");
		const jsonText = JSON.stringify(scored, null, 2);
		const mcpResult = { content: [{ type: "text" as const, text: jsonText }] };

		assertMcpEnvelope(mcpResult);
		// Verify the JSON content is parseable
		const parsed = JSON.parse(jsonText);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBeGreaterThan(0);
	});
});

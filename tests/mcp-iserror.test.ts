/**
 * Regression test for issue #545: MCP and Pi tool error responses missing
 * `isError: true`.
 *
 * In MCP, `isError` defaults to `false` when omitted. The codebase set
 * `isError: true` in only two places (mcp/tools.ts shazam_format and
 * tools/_factory.ts standard execute path). Every other error-text return --
 * path-traversal rejections, missing-param validations, and the blocked-rename
 * safety gate -- omitted it, so the LLM treated the response as a successful
 * tool result.
 *
 * This test invokes each affected handler via a capture-server (MCP path) and
 * a capture-pi (Pi customExecute path) and asserts `result.isError === true`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Silence audit-log disk writes triggered by withLogging() fire-and-forget.
vi.mock("node:fs/promises", () => ({
	appendFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../core/audit-log.js", () => ({
	AUDIT_LOG_DIR: "/tmp/pi-shazam-test-audit",
	INTERNAL_LOG_PATH: "/tmp/pi-shazam-test-audit/internal.log",
	rotateAuditLog: vi.fn().mockResolvedValue(undefined),
	writeJsonl: vi.fn(),
	ts: () => new Date().toISOString(),
}));

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoGraph } from "../core/graph.js";
import type { ExtensionAPI, AgentToolResult, ExtensionContext } from "../types/pi-extension.js";
import { registerAllTools } from "../mcp/tools.js";
import { registerRenameSymbol } from "../tools/rename_symbol.js";
import { clearRenameState } from "../tools/rename-state.js";

// -- Capture harnesses --------------------------------------------------

interface CapturedHandler {
	(args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

function makeCaptureServer(): { server: McpServer; handlers: Map<string, CapturedHandler> } {
	const handlers = new Map<string, CapturedHandler>();
	const server = {
		registerTool(name: string, _opts: unknown, handler: CapturedHandler) {
			handlers.set(name, handler);
		},
	};
	return { server: server as unknown as McpServer, handlers };
}

interface CapturedPiTool {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult>;
}

function makeCapturePi(): { pi: ExtensionAPI; captured: () => CapturedPiTool | undefined } {
	let tool: CapturedPiTool | undefined;
	const pi = {
		registerTool(spec: { execute: CapturedPiTool["execute"] }) {
			tool = { execute: spec.execute };
		},
	};
	return { pi: pi as unknown as ExtensionAPI, captured: () => tool };
}

const DUMMY_GRAPH = {} as RepoGraph;
const DUMMY_CTX = {} as ExtensionContext;

// -- MCP path: isError:true on error returns (#545) ----------------------

describe("MCP error responses set isError:true (#545)", () => {
	let handlers: Map<string, CapturedHandler>;

	beforeEach(() => {
		clearRenameState();
		const captured = makeCaptureServer();
		handlers = captured.handlers;
		registerAllTools(captured.server, () => DUMMY_GRAPH, ".");
	});

	it("shazam_lookup missing name returns isError:true", async () => {
		const result = await handlers.get("shazam_lookup")!({});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Error");
	});

	it("shazam_lookup name path-traversal returns isError:true", async () => {
		const result = await handlers.get("shazam_lookup")!({ name: "../../etc/passwd" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("outside the project root");
	});

	it("shazam_lookup file path-traversal returns isError:true", async () => {
		const result = await handlers.get("shazam_lookup")!({
			name: "someSymbol",
			file: "../../etc/passwd",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("outside the project root");
	});

	it("shazam_impact missing symbol and files returns isError:true", async () => {
		const result = await handlers.get("shazam_impact")!({});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Error:");
	});

	it("shazam_impact files path-traversal returns isError:true", async () => {
		const result = await handlers.get("shazam_impact")!({ files: ["../../etc/passwd"] });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("outside the project root");
	});

	it("shazam_rename_symbol [BLOCKED] safety gate returns isError:true", async () => {
		// No prior recordCallChain -- rename must be blocked.
		const result = await handlers.get("shazam_rename_symbol")!({
			symbol: "someSymbol",
			newName: "newName",
			dryRun: false,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("[BLOCKED]");
	});

	it("shazam_format path-traversal already sets isError:true (reference pattern)", async () => {
		// Pre-existing correct usage -- documents the reference pattern.
		const result = await handlers.get("shazam_format")!({ file: "../../etc/passwd" });
		expect(result.isError).toBe(true);
	});
});

// -- Pi path: isError:true on customExecute error returns (#545) ---------

describe("Pi rename_symbol customExecute error responses set isError:true (#545)", () => {
	let tool: CapturedPiTool;

	beforeEach(() => {
		clearRenameState();
		const capture = makeCapturePi();
		registerRenameSymbol(capture.pi);
		tool = capture.captured()!;
	});

	it("missing symbol returns isError:true", async () => {
		const result = await tool.execute("id", { symbol: "", newName: "newName" }, undefined, undefined, DUMMY_CTX);
		expect(result.isError).toBe(true);
		// `result.content[0]` is `TextContent | ImageContent` in the
		// MCP SDK's typing; the rename tool only ever emits text
		// content, so narrowing with a type guard keeps the test
		// honest without an `as` cast.
		const first = result.content[0];
		expect(first?.type).toBe("text");
		expect((first as { text: string }).text).toContain("Error");
	});

	it("missing newName returns isError:true", async () => {
		const result = await tool.execute("id", { symbol: "oldName", newName: "" }, undefined, undefined, DUMMY_CTX);
		expect(result.isError).toBe(true);
		const first = result.content[0];
		expect(first?.type).toBe("text");
		expect((first as { text: string }).text).toContain("Error");
	});

	it("[BLOCKED] safety gate returns isError:true", async () => {
		// No prior recordCallChain -- rename must be blocked, not silently succeed.
		const result = await tool.execute(
			"id",
			{ symbol: "someSymbol", newName: "newName", dryRun: false },
			undefined,
			undefined,
			DUMMY_CTX,
		);
		expect(result.isError).toBe(true);
		const first = result.content[0];
		expect(first?.type).toBe("text");
		expect((first as { text: string }).text).toContain("[BLOCKED]");
	});
});

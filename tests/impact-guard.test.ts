/**
 * Tests for hooks/impact-state, hooks/issue-guard, hooks/agent-context-guard,
 * and the pre-edit impact blocking integration.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setPendingImpact, clearPendingImpact, hasPendingImpact, resetImpactState } from "../hooks/impact-state.js";
import { registerIssueGuard } from "../hooks/issue-guard.js";
import { registerAgentContextGuard } from "../hooks/agent-context-guard.js";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "../types/pi-extension.js";

// ---------------------------------------------------------------------------
// Mock ExtensionAPI that captures event handlers
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown, ctx: unknown) => unknown;

function createMockPi() {
	const handlers = new Map<string, EventHandler[]>();

	const pi = {
		on(event: string, handler: EventHandler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
	} as unknown as ExtensionAPI;

	function emit(event: string, eventData: unknown, ctx?: unknown): unknown[] {
		const fns = handlers.get(event) || [];
		return fns.map((fn) => fn(eventData, ctx || createMockCtx()));
	}

	return { pi, handlers, emit };
}

function createMockCtx() {
	return {
		cwd: "/test",
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(),
			select: vi.fn(),
		},
	};
}

function makeBashToolCall(command: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "test-call-1",
		toolName: "bash",
		input: { command },
	};
}

function makeToolResult(toolName: string, isError = false): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "test-result-1",
		toolName,
		input: {},
		content: [{ type: "text", text: "" }],
		isError,
	} as ToolResultEvent;
}

// ---------------------------------------------------------------------------
// impact-state tests
// ---------------------------------------------------------------------------

describe("hooks/impact-state", () => {
	beforeEach(() => {
		resetImpactState();
	});

	it("should start with no pending impact", () => {
		expect(hasPendingImpact()).toBe(false);
	});

	it("setPendingImpact sets the flag to true", () => {
		setPendingImpact();
		expect(hasPendingImpact()).toBe(true);
	});

	it("clearPendingImpact resets the flag to false", () => {
		setPendingImpact();
		expect(hasPendingImpact()).toBe(true);
		clearPendingImpact();
		expect(hasPendingImpact()).toBe(false);
	});

	it("resetImpactState resets everything", () => {
		setPendingImpact();
		expect(hasPendingImpact()).toBe(true);
		resetImpactState();
		expect(hasPendingImpact()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// issue-guard tests
// ---------------------------------------------------------------------------

describe("hooks/issue-guard", () => {
	beforeEach(() => {
		resetImpactState();
	});

	it("should set pending impact for serious issue (fix/crash)", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		emit("tool_call", makeBashToolCall('gh issue create --title "fix: P0 crash in production"'));
		expect(hasPendingImpact()).toBe(true);
	});

	it("should set pending impact for bug-related issue", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		emit("tool_call", makeBashToolCall('gh issue create --title "bug: memory leak detected"'));
		expect(hasPendingImpact()).toBe(true);
	});

	it("should NOT set pending impact for trivial issue (docs/typo)", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		emit("tool_call", makeBashToolCall('gh issue create --title "docs: update readme"'));
		expect(hasPendingImpact()).toBe(false);
	});

	it("should NOT set pending impact for chore issues even with error keyword", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		// "chore" + "error" — trivial pattern wins because both match
		emit("tool_call", makeBashToolCall('gh issue create --title "chore: update error codes"'));
		expect(hasPendingImpact()).toBe(false);
	});

	it("should NOT trigger for non-gh-issue commands", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		emit("tool_call", makeBashToolCall("ls -la"));
		expect(hasPendingImpact()).toBe(false);
	});

	it("should NOT trigger for non-bash tool calls", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		emit("tool_call", {
			type: "tool_call",
			toolCallId: "test-1",
			toolName: "write",
			input: { path: "/test/file.ts", content: "" },
		});
		expect(hasPendingImpact()).toBe(false);
	});

	it("should clear pending impact when shazam_impact tool_result arrives", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		// First: create a serious issue
		emit("tool_call", makeBashToolCall('gh issue create --title "fix: crash"'));
		expect(hasPendingImpact()).toBe(true);

		// Then: shazam_impact completes
		emit("tool_result", makeToolResult("shazam_impact"));
		expect(hasPendingImpact()).toBe(false);
	});

	it("should NOT clear pending impact for other tool results", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		emit("tool_call", makeBashToolCall('gh issue create --title "fix: crash"'));
		expect(hasPendingImpact()).toBe(true);

		emit("tool_result", makeToolResult("shazam_verify"));
		expect(hasPendingImpact()).toBe(true);
	});

	it("should reset pending impact on session_start", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		setPendingImpact();
		expect(hasPendingImpact()).toBe(true);

		emit("session_start", { type: "session_start" });
		expect(hasPendingImpact()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// agent-context-guard tests
// ---------------------------------------------------------------------------

describe("hooks/agent-context-guard", () => {
	it("should block review prompts with no structural context", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		// A long review prompt with no file paths, symbols, line numbers, or shazam refs
		const prompt =
			"Please review the security of this codebase and check for potential vulnerabilities in the authentication system and database access patterns and make sure everything is properly validated and sanitized before processing user input";

		const results = emit("tool_call", {
			type: "tool_call",
			toolCallId: "test-1",
			toolName: "agent",
			input: { prompt },
		});

		const blockResult = results.find(
			(r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).block === true,
		);
		expect(blockResult).toBeDefined();
		expect((blockResult as Record<string, unknown>).reason).toContain("structural context");
	});

	it("should allow review prompts with sufficient context (file paths + shazam)", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		// Review prompt with explicit file paths and shazam references (score >= 2)
		const prompt =
			"Please review the security of src/auth/login.ts and src/db/queries.ts modules carefully. Run shazam_file_detail to check the structure and shazam_codesearch to find potential vulnerabilities in the authentication flow and database patterns";

		const results = emit("tool_call", {
			type: "tool_call",
			toolCallId: "test-2",
			toolName: "agent",
			input: { prompt },
		});

		const blockResult = results.find(
			(r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).block === true,
		);
		expect(blockResult).toBeUndefined();
	});

	it("should NOT block coding prompts (warning only, no block)", () => {
		const { pi, emit } = createMockPi();
		const mockCtx = createMockCtx();
		registerAgentContextGuard(pi);

		// Coding prompt with no structural context — should warn but not block.
		// Avoid file extensions at end of string to keep context score at 0.
		const prompt =
			"Please implement a new feature for the user authentication system that adds two-factor authentication support with TOTP tokens and backup codes for all user accounts in the entire application layer";

		const results = emit(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "test-3",
				toolName: "agent",
				input: { prompt },
			},
			mockCtx,
		);

		const blockResult = results.find(
			(r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).block === true,
		);
		expect(blockResult).toBeUndefined();

		// Should have sent a warning notification
		expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("lacks structural context"), "warning");
	});

	it("should skip short prompts (< 30 words)", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		// Short review prompt (under 30 words)
		const prompt = "Review the auth module for security issues";

		const results = emit("tool_call", {
			type: "tool_call",
			toolCallId: "test-4",
			toolName: "agent",
			input: { prompt },
		});

		const blockResult = results.find(
			(r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).block === true,
		);
		expect(blockResult).toBeUndefined();
	});

	it("should NOT trigger for non-agent tools", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		const results = emit("tool_call", {
			type: "tool_call",
			toolCallId: "test-5",
			toolName: "bash",
			input: { command: "echo hello" },
		});

		const blockResult = results.find(
			(r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).block === true,
		);
		expect(blockResult).toBeUndefined();
	});

	it("should trigger for agent_swarm tool name", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		const prompt =
			"Please review the security and integrity of the entire authentication system and check for potential vulnerabilities in the login flow and session management and database access patterns throughout the whole codebase carefully";

		const results = emit("tool_call", {
			type: "tool_call",
			toolCallId: "test-6",
			toolName: "agent_swarm",
			input: { prompt },
		});

		const blockResult = results.find(
			(r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).block === true,
		);
		expect(blockResult).toBeDefined();
	});

	it("should trigger for subagent tool name", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		const prompt =
			"Please audit the security of this entire codebase very thoroughly and check for SQL injection vulnerabilities and cross-site scripting issues and improper authentication handling patterns across all modules and services";

		const results = emit("tool_call", {
			type: "tool_call",
			toolCallId: "test-7",
			toolName: "subagent",
			input: { prompt },
		});

		const blockResult = results.find(
			(r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).block === true,
		);
		expect(blockResult).toBeDefined();
	});

	it("should skip prompts with no input", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		const results = emit("tool_call", {
			type: "tool_call",
			toolCallId: "test-8",
			toolName: "agent",
			input: {},
		});

		const blockResult = results.find(
			(r: unknown) => r && typeof r === "object" && (r as Record<string, unknown>).block === true,
		);
		expect(blockResult).toBeUndefined();
	});
});
